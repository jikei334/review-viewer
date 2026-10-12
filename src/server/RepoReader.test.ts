/**
 * T1-2: RepoReader の単体テスト(S1-4、S1-5、S1-6、C-5)
 *
 * セキュリティ基準の回帰テスト。機能追加のときに外さない。
 *
 * フィクスチャは、テストの中で OS の一時ディレクトリに作る(__fixtures__/temp-repo.ts)。
 * 秘密ファイルに見えるファイルの中身は、すべてダミーの文字列。
 */
import { mkdir, symlink, truncate } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempRepo, type TempRepo } from './__fixtures__/temp-repo.js';
import { RepoAccessError } from './path-policy.js';
import {
  decodeText,
  DEFAULT_MAX_FILE_BYTES,
  RepoReader,
  RepoUnavailableError,
  toRepoSegments,
} from './RepoReader.js';

/** リポジトリの外に置いたファイルの中身。結果に出てはいけない */
const OUTSIDE_SENTINEL = 'UNIT_OUTSIDE_REPO_SENTINEL_MUST_NOT_LEAK';
/** 秘密ファイルに見えるダミーの中身。結果に出てはいけない */
const SECRET_SENTINEL = 'UNIT_DUMMY_SECRET_SENTINEL_NOT_A_REAL_SECRET';
/** `.gitignore` の対象のファイルの中身。結果に出てはいけない */
const IGNORED_SENTINEL = 'UNIT_GITIGNORED_SENTINEL_MUST_NOT_LEAK';

/** フィクスチャに置く、秘密ファイルに見えるダミー(リポジトリ相対パス) */
const SECRET_PATHS = [
  '.env',
  '.env.local',
  '.env.example',
  'subdir/.env',
  '.git/config',
  '.git/HEAD',
  'secret.pem',
  'server.key',
  'subdir/nested/private.key',
  'id_rsa',
  'id_rsa.pub',
  'credentials',
  'credentials.json',
  '.claude.json',
  '.claude/credentials.json',
];

/** フィクスチャに置く、`.gitignore` の対象のファイル */
const IGNORED_PATHS = [
  'excluded-by-git.txt',
  'debug.log',
  'subdir/trace.log',
  'build-out/artifact.txt',
  'reports/2026-12-31-ignored.md',
  'subdir/local-only.tmp',
];

/** 通常のソースファイルの中身 */
const EXAMPLE_SOURCE = 'export function increment(n: number): number {\n  return n + 1;\n}\n';
/** その大きさ(バイト) */
const EXAMPLE_SIZE = Buffer.byteLength(EXAMPLE_SOURCE);

let repo: TempRepo;
let reader: RepoReader;

/**
 * 拒否された理由を取り出す
 *
 * @param promise RepoReader の呼び出し
 * @returns `code` と `reason`(拒否されなければ、テストを失敗させる)
 */
async function rejectionOf(promise: Promise<unknown>): Promise<{ code: string; reason: string }> {
  try {
    const value = await promise;
    throw new Error(`拒否されなかった: ${JSON.stringify(value).slice(0, 200)}`);
  } catch (err) {
    if (err instanceof RepoAccessError) return { code: err.code, reason: err.reason };
    throw err;
  }
}

beforeAll(async () => {
  repo = await createTempRepo();
  reader = new RepoReader({ repoDir: repo.repoDir });

  // 通常のファイル
  await repo.write('src/example.ts', EXAMPLE_SOURCE);
  await repo.write('subdir/normal.ts', 'export const normal = true;\n');
  await repo.write('subdir/nested/visible.txt', 'UNIT_VISIBLE_NESTED_FILE\n');
  await repo.write('reports/2026-10-12-feature.md', '# feature\n');
  await repo.write('README.md', '# 日本語の README\n');

  // 秘密ファイルに見えるダミー
  for (const path of SECRET_PATHS) {
    await repo.write(path, `# 単体テストのダミー(本物の秘密ではない)\nDUMMY=${SECRET_SENTINEL}\n`);
  }

  // .gitignore と、その対象。否定パターンで秘密ファイルを戻そうとしても、秘密の判定が優先される
  await repo.write(
    '.gitignore',
    ['excluded-by-git.txt', '*.log', 'build-out/', 'reports/2026-12-31-ignored.md', '!.env', '!secret.pem', '!subdir/.env', ''].join('\n')
  );
  await repo.write('subdir/.gitignore', '*.tmp\n');
  for (const path of IGNORED_PATHS) {
    await repo.write(path, `${IGNORED_SENTINEL}\n`);
  }

  // リポジトリの外
  const outsideFile = await repo.writeOutside('outside-secret.txt', `${OUTSIDE_SENTINEL}\n`);
  await repo.writeOutside('dir/inner.txt', `${OUTSIDE_SENTINEL}\n`);

  // リポジトリの外を指すシンボリックリンク(絶対、相対、多段、ディレクトリ、サブディレクトリの中)
  await repo.link(outsideFile, 'link-abs-file.txt');
  await repo.link('../outside/outside-secret.txt', 'link-rel-file.txt');
  await repo.link('link-abs-file.txt', 'link-chain.txt');
  await repo.link('link-chain.txt', 'link-chain-2.txt');
  await repo.link(join(repo.outsideDir, 'dir'), 'link-dir');
  await repo.link('../outside/dir', 'link-dir-rel');
  await repo.link('../../outside/outside-secret.txt', 'src/link-in-subdir.ts');
  await repo.link('..', 'link-parent');

  // リポジトリの中の秘密ファイル・.gitignore の対象を指す、無害な名前のリンク
  await repo.link('.env', 'notes-link.txt');
  await repo.link('notes-link.txt', 'notes-link-chain.txt');
  await repo.link('.git', 'vcs-link');
  await repo.link('debug.log', 'ignored-target-link.txt');
  await repo.link('build-out', 'ignored-dir-link');
  // リンクの名前のほうが .gitignore の対象(指している先は通常のファイル)
  await repo.link('src/example.ts', 'named-like-ignored.log');
  // リンクの名前のほうが秘密ファイル
  await repo.link('src/example.ts', 'alias.key');

  // リポジトリの中の通常のファイル・ディレクトリを指すリンク(これは読める)
  await repo.link('src/example.ts', 'inner-link.ts');
  await repo.link('src', 'inner-dir-link');

  // 指している先が無いリンクと、循環するリンク
  await repo.link('no-such-target.txt', 'dangling-link.txt');
  await repo.link('loop-b', 'loop-a');
  await repo.link('loop-a', 'loop-b');
});

afterAll(async () => {
  await repo.cleanup();
});

describe('T1-2: RepoReader.readFile(通常のファイル)', () => {
  it('T1-2: リポジトリの中のテキストファイルは、本文が返る', async () => {
    const file = await reader.readFile('src/example.ts');
    expect(file).toEqual({
      path: 'src/example.ts',
      size: EXAMPLE_SIZE,
      kind: 'text',
      content: EXAMPLE_SOURCE,
    });
  });

  it.each(['./src/example.ts', 'src//example.ts', 'src/./example.ts', 'src/example.ts/'])(
    'T1-2: 書き方が違っても(%j)、同じファイルとして、正規化したパスで返る',
    async (path) => {
      const file = await reader.readFile(path);
      expect(file.path).toBe('src/example.ts');
      expect(file.kind).toBe('text');
    }
  );

  it('T1-2: .gitignore そのものは、秘密でも除外対象でもないので読める', async () => {
    const file = await reader.readFile('.gitignore');
    expect(file.kind).toBe('text');
  });

  it('T1-2: リポジトリの中の通常のファイルを指すリンクは、指定した名前のパスで読める', async () => {
    const file = await reader.readFile('inner-link.ts');
    expect(file).toMatchObject({ path: 'inner-link.ts', kind: 'text' });
    const viaDir = await reader.readFile('inner-dir-link/example.ts');
    expect(viaDir).toMatchObject({ path: 'inner-dir-link/example.ts', kind: 'text' });
  });

  it('T1-2: REPO_DIR 自体がシンボリックリンクでも、指している先をルートとして読める', async () => {
    const alias = join(repo.baseDir, 'repo-alias');
    await symlink(repo.repoDir, alias);
    const viaAlias = new RepoReader({ repoDir: alias });
    expect((await viaAlias.readFile('src/example.ts')).kind).toBe('text');
    expect(await rejectionOf(viaAlias.readFile('link-abs-file.txt'))).toEqual({ code: 'not_found', reason: 'outside' });
  });
});

describe('S1-4: RepoReader は、リポジトリの外のパスを拒否する', () => {
  it.each([
    '../outside/outside-secret.txt',
    'src/../../outside/outside-secret.txt',
    './../outside/outside-secret.txt',
    'no-such-dir/../../outside/outside-secret.txt',
    '../../../../../../../../etc/passwd',
    '..\\outside\\outside-secret.txt',
    '../outside/outside-secret.txt\u0000.md',
    '/etc/passwd',
    '//etc/passwd',
  ])('S1-4: readFile は %j を拒否する(形式の誤り)', async (path) => {
    expect((await rejectionOf(reader.readFile(path))).code).toBe('invalid_path');
  });

  it('S1-4: readFile は、リポジトリの外のファイルの絶対パスを拒否する', async () => {
    const absolute = join(repo.outsideDir, 'outside-secret.txt');
    expect(await rejectionOf(reader.readFile(absolute))).toEqual({ code: 'invalid_path', reason: 'absolute' });
  });

  it.each(['....//outside/outside-secret.txt', '%2e%2e%2foutside%2foutside-secret.txt', '..%2foutside-secret.txt', 'file:///etc/passwd'])(
    'S1-4: readFile は %j を、その名前のファイルとして探し、見つからないとする',
    async (path) => {
      expect(await rejectionOf(reader.readFile(path))).toEqual({ code: 'not_found', reason: 'missing' });
    }
  );

  it.each([
    ['絶対パスのリンク', 'link-abs-file.txt'],
    ['相対パスのリンク', 'link-rel-file.txt'],
    ['リンクを経由するリンク', 'link-chain.txt'],
    ['リンクを2回経由するリンク', 'link-chain-2.txt'],
    ['サブディレクトリの中のリンク', 'src/link-in-subdir.ts'],
    ['ディレクトリへのリンク(絶対)の配下', 'link-dir/inner.txt'],
    ['ディレクトリへのリンク(相対)の配下', 'link-dir-rel/inner.txt'],
    ['親ディレクトリへのリンクの配下', 'link-parent/outside/outside-secret.txt'],
  ])('S1-4: readFile は、リポジトリの外を指すシンボリックリンク(%s)を拒否する', async (_label, path) => {
    expect(await rejectionOf(reader.readFile(path))).toEqual({ code: 'not_found', reason: 'outside' });
  });

  it('S1-4: リポジトリと名前の前半が同じ、隣のディレクトリ(repo-evil)を、中とみなさない', async () => {
    const sibling = `${repo.repoDir}-evil`;
    await mkdir(sibling);
    await repo.link(join(sibling), 'link-sibling-dir');
    expect(await rejectionOf(reader.listDirectory('link-sibling-dir'))).toEqual({ code: 'not_found', reason: 'outside' });
    expect(toRepoSegments('/repo', '/repo-evil/x')).toBeNull();
    expect(toRepoSegments('/repo', '/repo')).toEqual([]);
    expect(toRepoSegments('/repo', ['', 'repo', 'a', 'b'].join(sep))).toEqual(['a', 'b']);
    expect(toRepoSegments('/', '/etc')).toEqual(['etc']);
    expect(toRepoSegments('/repo', '/')).toBeNull();
    expect(toRepoSegments('/repo/sub', '/repo')).toBeNull();
  });

  it.each(['..', '../', 'src/../..', '../outside/dir', '/etc', '/'])(
    'S1-4: listDirectory は %j を拒否する(形式の誤り)',
    async (path) => {
      expect((await rejectionOf(reader.listDirectory(path))).code).toBe('invalid_path');
    }
  );

  it.each(['link-dir', 'link-dir-rel', 'link-parent', 'link-parent/outside'])(
    'S1-4: listDirectory は、リポジトリの外を指すシンボリックリンク(%s)を拒否する',
    async (path) => {
      expect(await rejectionOf(reader.listDirectory(path))).toEqual({ code: 'not_found', reason: 'outside' });
    }
  );

  it('S1-4: 指している先が無いリンクと、循環するリンクは、見つからないとする', async () => {
    expect(await rejectionOf(reader.readFile('dangling-link.txt'))).toEqual({ code: 'not_found', reason: 'missing' });
    expect(await rejectionOf(reader.readFile('loop-a'))).toEqual({ code: 'not_found', reason: 'missing' });
  });

  it('S1-4: 存在しないパス、ファイルでないもの、ディレクトリでないものは、見つからないとする', async () => {
    expect(await rejectionOf(reader.readFile('no-such-file.txt'))).toEqual({ code: 'not_found', reason: 'missing' });
    expect(await rejectionOf(reader.readFile('src/example.ts/child'))).toEqual({ code: 'not_found', reason: 'missing' });
    expect(await rejectionOf(reader.readFile('src'))).toEqual({ code: 'not_found', reason: 'not_a_file' });
    expect(await rejectionOf(reader.readFile(''))).toEqual({ code: 'not_found', reason: 'not_a_file' });
    expect(await rejectionOf(reader.listDirectory('src/example.ts'))).toEqual({ code: 'not_found', reason: 'not_a_directory' });
    expect(await rejectionOf(reader.listDirectory('no-such-dir'))).toEqual({ code: 'not_found', reason: 'missing' });
  });
});

describe('S1-5: RepoReader は、秘密ファイルと .gitignore の対象を拒否する', () => {
  it.each(SECRET_PATHS)('S1-5: readFile は %s を拒否する(秘密ファイル)', async (path) => {
    expect(await rejectionOf(reader.readFile(path))).toEqual({ code: 'not_found', reason: 'secret' });
  });

  it.each(['./.env', './/.env', '.env/', 'subdir//.env', './subdir/./.env', '.git//config', './.git/config'])(
    'S1-5: 書き方を変えても(%j)、秘密ファイルは拒否する',
    async (path) => {
      expect(await rejectionOf(reader.readFile(path))).toEqual({ code: 'not_found', reason: 'secret' });
    }
  );

  it.each(['.ENV', '.Env', '.GIT/config', '.git/CONFIG', 'SECRET.PEM', 'Server.Key', 'ID_RSA', 'CREDENTIALS.json', '.CLAUDE.JSON'])(
    'S1-5: 大文字小文字を変えても(%j)、中身は返らない',
    async (path) => {
      // 大文字小文字を区別しないファイルシステムでは、同じファイルを指す。名前の判定で拒否する
      expect((await rejectionOf(reader.readFile(path))).code).toBe('not_found');
    }
  );

  it.each(['src/../.env', '.git/../.env', 'subdir//../.env', 'src/../.git/config', '.env\u0000.md'])(
    'S1-5: `..` や NUL を使った書き方(%j)は、形式の誤りとして拒否する',
    async (path) => {
      expect((await rejectionOf(reader.readFile(path))).code).toBe('invalid_path');
    }
  );

  it('S1-5: 存在しない秘密ファイルも、存在するものと同じ結果になる(存在を調べられない)', async () => {
    expect(await rejectionOf(reader.readFile('no-such-dir/.env'))).toEqual({ code: 'not_found', reason: 'secret' });
    expect(await rejectionOf(reader.readFile('subdir/.env'))).toEqual({ code: 'not_found', reason: 'secret' });
  });

  it.each([
    ['秘密ファイルを指すリンク', 'notes-link.txt'],
    ['秘密ファイルを指すリンクを経由するリンク', 'notes-link-chain.txt'],
    ['.git を指すリンクの配下', 'vcs-link/config'],
    ['名前が秘密ファイルのリンク(指している先は通常のファイル)', 'alias.key'],
  ])('S1-5: readFile は、%s を拒否する(リンク名でも実体でも判定する)', async (_label, path) => {
    expect(await rejectionOf(reader.readFile(path))).toEqual({ code: 'not_found', reason: 'secret' });
  });

  it.each(IGNORED_PATHS)('S1-5: readFile は %s を拒否する(.gitignore の対象)', async (path) => {
    expect(await rejectionOf(reader.readFile(path))).toEqual({ code: 'not_found', reason: 'ignored' });
  });

  it.each([
    ['.gitignore の対象を指すリンク', 'ignored-target-link.txt'],
    ['.gitignore の対象のディレクトリを指すリンクの配下', 'ignored-dir-link/artifact.txt'],
    ['名前が .gitignore の対象のリンク(指している先は通常のファイル)', 'named-like-ignored.log'],
  ])('S1-5: readFile は、%s を拒否する', async (_label, path) => {
    expect(await rejectionOf(reader.readFile(path))).toEqual({ code: 'not_found', reason: 'ignored' });
  });

  it('S1-5: .gitignore の否定パターンで秘密ファイルを戻そうとしても、秘密の判定が優先される', async () => {
    // フィクスチャの .gitignore には `!.env`、`!secret.pem`、`!subdir/.env` がある
    for (const path of ['.env', 'secret.pem', 'subdir/.env']) {
      expect(await rejectionOf(reader.readFile(path))).toEqual({ code: 'not_found', reason: 'secret' });
    }
  });

  it.each([
    ['.git', 'secret'],
    ['.git/', 'secret'],
    ['.GIT', 'secret'],
    ['.claude/credentials.json', 'secret'],
    ['vcs-link', 'secret'],
    ['build-out', 'ignored'],
    ['build-out/', 'ignored'],
    ['ignored-dir-link', 'ignored'],
  ])('S1-5: listDirectory は %j の中身を返さない(%s)', async (path, reason) => {
    expect(await rejectionOf(reader.listDirectory(path))).toEqual({ code: 'not_found', reason });
  });

  it('S1-5: ルートの一覧に、秘密ファイル、.gitignore の対象、外を指すリンク、切れたリンクが出ない', async () => {
    const root = await reader.listDirectory('');
    expect(root.path).toBe('');
    // 載るものを、すべて列挙して固定する(載せてはいけないものが1つでも増えたら失敗する)
    expect(root.entries.map((entry) => `${entry.type}:${entry.path}`)).toEqual([
      'directory:.claude',
      'file:.gitignore',
      'file:README.md',
      'directory:inner-dir-link',
      'file:inner-link.ts',
      'directory:reports',
      'directory:src',
      'directory:subdir',
    ]);
  });

  it('S1-5: サブディレクトリの一覧にも、秘密ファイルと .gitignore の対象が出ない', async () => {
    const names = async (path: string): Promise<string[]> =>
      (await reader.listDirectory(path)).entries.map((entry) => entry.name);

    // subdir/.env(秘密)、subdir/trace.log(ルートの .gitignore)、subdir/local-only.tmp(subdir の .gitignore)
    expect(await names('subdir')).toEqual(['.gitignore', 'nested', 'normal.ts']);
    // subdir/nested/private.key(秘密)
    expect(await names('subdir/nested')).toEqual(['visible.txt']);
    // reports/2026-12-31-ignored.md(.gitignore)
    expect(await names('reports')).toEqual(['2026-10-12-feature.md']);
    // src/link-in-subdir.ts(外を指すリンク)
    expect(await names('src')).toEqual(['example.ts']);
    // .claude/credentials.json(秘密)
    expect(await names('.claude')).toEqual([]);
    // リンク経由で開いたディレクトリでも同じ
    expect(await names('inner-dir-link')).toEqual(['example.ts']);
  });

  it('S1-5: 一覧の1件は、名前・パス・種類・大きさ・更新日時を持つ', async () => {
    await repo.setMtime('src/example.ts', new Date('2026-10-12T00:00:00Z'));
    const listing = await reader.listDirectory('./src/');
    expect(listing).toEqual({
      path: 'src',
      entries: [
        {
          name: 'example.ts',
          path: 'src/example.ts',
          type: 'file',
          size: EXAMPLE_SIZE,
          mtimeMs: Date.parse('2026-10-12T00:00:00Z'),
        },
      ],
    });
  });

  it('S1-5: .gitignore がシンボリックリンクなら、その規則は使わない(git と同じ。外の規則を持ち込まない)', async () => {
    const other = await createTempRepo();
    try {
      await other.writeOutside('rules', '*.ts\n');
      await other.link(join(other.outsideDir, 'rules'), '.gitignore');
      await other.write('a.ts', 'export {};\n');
      const otherReader = new RepoReader({ repoDir: other.repoDir });
      expect((await otherReader.readFile('a.ts')).kind).toBe('text');
      // リンクの .gitignore そのものは、外を指しているので読めない
      expect(await rejectionOf(otherReader.readFile('.gitignore'))).toEqual({ code: 'not_found', reason: 'outside' });
    } finally {
      await other.cleanup();
    }
  });
});

describe('C-5: RepoReader のエラーは、パスや中身を含まない', () => {
  it('C-5: 拒否のエラーのメッセージに、指定したパス、実体のパス、ファイルの中身が出ない', async () => {
    for (const path of ['.env', 'link-abs-file.txt', 'debug.log', 'no-such-file.txt', '../outside/outside-secret.txt']) {
      let caught: unknown;
      try {
        await reader.readFile(path);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RepoAccessError);
      const text = `${String(caught)}\n${(caught as Error).stack ?? ''}\n${JSON.stringify(caught)}`;
      // スタックには、このテストやソースのファイル名は出る。出てはいけないのは、フィクスチャの場所と中身
      expect(text).not.toContain(repo.baseDir);
      expect(text).not.toContain(SECRET_SENTINEL);
      expect(text).not.toContain(OUTSIDE_SENTINEL);
      expect(text).not.toContain(IGNORED_SENTINEL);
      expect((caught as Error).message).not.toContain(path);
    }
  });

  it('C-5: リポジトリのディレクトリが無いときのエラーは、そのパスをメッセージに含まない', async () => {
    const missing = new RepoReader({ repoDir: join(repo.baseDir, 'NO-SUCH-REPO-DIR') });
    const err = await missing.readFile('src/example.ts').then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(RepoUnavailableError);
    expect((err as Error).message).not.toContain('NO-SUCH-REPO-DIR');
    await expect(missing.listDirectory('')).rejects.toBeInstanceOf(RepoUnavailableError);
  });
});

describe('S1-6: RepoReader は、巨大ファイルとバイナリの本文を返さない', () => {
  it('S1-6: 上限の既定値は 1,048,576 バイト', () => {
    expect(DEFAULT_MAX_FILE_BYTES).toBe(1_048_576);
  });

  it('S1-6: ちょうど 1MB(1,048,576 バイト)のファイルは、本文が返る', async () => {
    await repo.write('size-exact.txt', 'a'.repeat(1_048_576));
    const file = await reader.readFile('size-exact.txt');
    expect(file.kind).toBe('text');
    expect(file.size).toBe(1_048_576);
    expect(file.kind === 'text' && file.content.length).toBe(1_048_576);
  });

  it('S1-6: 1MB を 1 バイト超えるファイルは、本文を返さず、その旨を返す', async () => {
    await repo.write('size-over.txt', 'a'.repeat(1_048_577));
    const file = await reader.readFile('size-over.txt');
    expect(file).toEqual({ path: 'size-over.txt', size: 1_048_577, kind: 'too_large', maxBytes: 1_048_576 });
    expect(file).not.toHaveProperty('content');
  });

  it('S1-6: 上限は注入できる(ちょうど / +1 バイト / 多バイト文字はバイト数で数える)', async () => {
    const small = new RepoReader({ repoDir: repo.repoDir, maxFileBytes: 10 });
    await repo.write('ten.txt', '0123456789');
    await repo.write('eleven.txt', '0123456789a');
    await repo.write('multibyte.txt', 'あいうえ'); // 4 文字、12 バイト
    expect(await small.readFile('ten.txt')).toMatchObject({ kind: 'text', content: '0123456789' });
    expect(await small.readFile('eleven.txt')).toEqual({ path: 'eleven.txt', size: 11, kind: 'too_large', maxBytes: 10 });
    expect(await small.readFile('multibyte.txt')).toMatchObject({ kind: 'too_large', size: 12 });
  });

  it('S1-6: 上限に、負の値や整数でない値は指定できない', () => {
    expect(() => new RepoReader({ repoDir: repo.repoDir, maxFileBytes: -1 })).toThrow(RangeError);
    expect(() => new RepoReader({ repoDir: repo.repoDir, maxFileBytes: 1.5 })).toThrow(RangeError);
    expect(() => new RepoReader({ repoDir: repo.repoDir, maxFileBytes: Number.NaN })).toThrow(RangeError);
  });

  it('S1-6: 巨大ファイルは、中身を読み込まずに判定する(8GB の疎なファイルでも、すぐに返る)', async () => {
    // 中身を持たない(ディスクを使わない)8GB のファイル。全体を読み込む実装なら、メモリが足りずに失敗する
    const path = await repo.write('huge-sparse.bin', '');
    await truncate(path, 8 * 1024 * 1024 * 1024);
    const startedAt = Date.now();
    const file = await reader.readFile('huge-sparse.bin');
    expect(file).toEqual({
      path: 'huge-sparse.bin',
      size: 8 * 1024 * 1024 * 1024,
      kind: 'too_large',
      maxBytes: DEFAULT_MAX_FILE_BYTES,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.each([
    ['PNG の先頭 + NUL', 'image.png'],
    ['拡張子は .txt だが、中身はバイナリ', 'binary-data.txt'],
  ])('S1-6: バイナリ(%s)は、本文を返さず、その旨を返す', async (_label, path) => {
    const binary = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
      Buffer.from('UNIT_BINARY_MARKER', 'ascii'),
      Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x01, 0x02, 0x80, 0x81]),
    ]);
    await repo.write(path, binary);
    const file = await reader.readFile(path);
    expect(file).toEqual({ path, size: binary.length, kind: 'binary' });
    expect(JSON.stringify(file)).not.toContain('UNIT_BINARY_MARKER');
  });

  it('S1-6: 拡張子が画像でも、中身がテキストなら本文が返る(中身で判定する)', async () => {
    await repo.write('actually-text.png', 'これはテキスト\n');
    expect(await reader.readFile('actually-text.png')).toMatchObject({ kind: 'text', content: 'これはテキスト\n' });
  });

  it('S1-6: 巨大で、かつバイナリのファイルは、巨大として返る(中身を調べない)', async () => {
    const small = new RepoReader({ repoDir: repo.repoDir, maxFileBytes: 4 });
    await repo.write('big-binary.bin', Buffer.from([0, 1, 2, 3, 4, 5]));
    expect(await small.readFile('big-binary.bin')).toMatchObject({ kind: 'too_large', size: 6 });
  });
});

describe('S1-6: decodeText(バイナリの判定)', () => {
  it('S1-6: UTF-8 のテキスト(日本語、絵文字、空)は、文字列になる', () => {
    expect(decodeText(Buffer.from('hello\n'))).toBe('hello\n');
    expect(decodeText(Buffer.from('日本語のテキスト 🎉\r\n'))).toBe('日本語のテキスト 🎉\r\n');
    expect(decodeText(new Uint8Array())).toBe('');
  });

  it('S1-6: 先頭の BOM は取り除く', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
  });

  it.each<[string, number[]]>([
    ['NUL を含む', [0x61, 0x00, 0x62]],
    ['末尾が NUL', [0x61, 0x62, 0x00]],
    ['UTF-8 として正しくない(0xff)', [0x61, 0xff, 0x62]],
    ['UTF-8 の途中で切れている', [0xe3, 0x81]],
    ['UTF-16LE(NUL を含む)', [0xff, 0xfe, 0x61, 0x00]],
    ['Shift_JIS(「あ」= 0x82 0xa0)', [0x82, 0xa0]],
  ])('S1-6: %s ものは、バイナリ(null)', (_label, bytes) => {
    expect(decodeText(Uint8Array.from(bytes))).toBeNull();
  });
});
