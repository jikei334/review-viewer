/**
 * e2e API テスト(ステージ1)
 * 対象基準: S1-1(レポート一覧)、S1-4(リポジトリ外の拒否)、S1-5(秘密ファイル・.gitignore の除外)、
 *           S1-6(巨大ファイル・バイナリ)
 *
 * SPEC §2.2 と §4 の受け入れ基準だけを根拠とする。src/ は読まない。
 *
 * SPEC は、応答の JSON の形(フィールド名)と、拒否するときのステータスコードを定めていない。
 * そのため、次の方針で検証する。
 * - 一覧に載っているかどうかは、JSON に含まれる文字列を形に依存せずに調べる(helpers/http.ts の listsName)
 * - 「拒否」は、4xx であることと、ファイルの中身(目印の文字列)が応答に含まれないことで確かめる
 */

import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeniedFiles, listDeniedFiles } from './helpers/fixtures.js';
import { bodyContains, listsName, request, tryParseJson, type HttpResult } from './helpers/http.js';
import { startTestServer, stopIfStarted, type TestServer } from './helpers/server.js';

/** コミット済みフィクスチャのレポート(新しい順) */
const REPORTS_NEWEST_FIRST = [
  '2026-10-12-feature.md',
  '2026-09-01-initial.md',
  '2026-08-03-gfm.md',
  '2026-08-02-xss.md',
  '2026-08-01-mermaid.md',
];

/**
 * 応答が「拒否」であることを確かめる(4xx で、禁止された中身を含まない)
 *
 * @param res 応答
 * @param label 失敗時に表示する、リクエストの説明
 * @param forbidden 応答に含まれてはいけない文字列
 * @returns なし(満たさなければ、その場でテストが失敗する)
 */
function expectRejected(res: HttpResult, label: string, forbidden: string[] = []): void {
  expect(res.status, `${label} が ${res.status} を返した(4xx で拒否されるべき)`).toBeGreaterThanOrEqual(400);
  expect(res.status, `${label} が ${res.status} を返した(4xx で拒否されるべき)`).toBeLessThan(500);
  for (const text of forbidden) {
    expect(bodyContains(res.text, text), `${label} の応答に「${text}」が含まれている`).toBe(false);
  }
}

// ─── S1-1: GET /api/reports ───────────────────────────────────────────────────

describe('S1-1: GET /api/reports', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({
      setup: async (repoDir) => {
        // reports/*.md に当てはまらないファイル
        await writeFile(join(repoDir, 'reports/2026-11-01-not-markdown.txt'), 'Markdown ではない\n');
        await writeFile(join(repoDir, '2026-11-02-outside-reports.md'), '# reports/ の外にある Markdown\n');
      },
    });
  });

  afterAll(async () => {
    await stopIfStarted(server);
  });

  it('S1-1: GET /api/reports は 200 で JSON を返す', async () => {
    const res = await request(server, '/api/reports');
    expect(res.status).toBe(200);
    expect(tryParseJson(res.text).ok, 'JSON として解釈できない').toBe(true);
  });

  it('S1-1: reports/ 配下の .md がすべて含まれる', async () => {
    const res = await request(server, '/api/reports');
    expect(res.status).toBe(200);
    for (const name of REPORTS_NEWEST_FIRST) {
      expect(res.text, `${name} が一覧に無い`).toContain(name);
    }
  });

  it('S1-1: 新しい順に並ぶ', async () => {
    // フィクスチャは、ファイル名の日付と更新日時を一致させてある(helpers/server.ts)。
    // 「新しい順」が、どちらを基準にしていても同じ並びになる
    const res = await request(server, '/api/reports');
    expect(res.status).toBe(200);
    const positions = REPORTS_NEWEST_FIRST.map((name) => res.text.indexOf(name));
    for (const [i, pos] of positions.entries()) {
      expect(pos, `${REPORTS_NEWEST_FIRST[i]} が一覧に無い`).toBeGreaterThanOrEqual(0);
    }
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions, `出現位置が新しい順になっていない: ${JSON.stringify(positions)}`).toEqual(sorted);
  });

  it('S1-1: reports/*.md に当てはまらないファイル(.md 以外、reports/ の外)は含まれない', async () => {
    const res = await request(server, '/api/reports');
    expect(res.status).toBe(200);
    // 一覧が空では検証にならないので、載るべきレポートがあることも確かめる
    expect(res.text).toContain('2026-10-12-feature.md');
    expect(res.text).not.toContain('2026-11-01-not-markdown');
    expect(res.text).not.toContain('2026-11-02-outside-reports');
  });
});

// ─── S1-4: リポジトリ外のパスの拒否 ───────────────────────────────────────────

describe('S1-4: Paths outside the repository are rejected', () => {
  let server: TestServer;
  /** リポジトリの外に置いたファイルの中身。応答に出てはいけない */
  const OUTSIDE_SENTINEL = 'E2E_OUTSIDE_REPO_SENTINEL_MUST_NOT_LEAK';
  /** リポジトリの外に置いたディレクトリの中のファイル名。一覧に出てはいけない */
  const OUTSIDE_INNER_NAME = 'e2e-outside-inner-file.txt';
  /** リポジトリの外のファイルの絶対パス(起動時に決まる) */
  let outsideFile = '';
  /** リポジトリの外のディレクトリの絶対パス(起動時に決まる) */
  let outsideDir = '';

  beforeAll(async () => {
    server = await startTestServer({
      setup: async (repoDir) => {
        // repoDir の隣(=リポジトリの外)に、目印つきのファイルとディレクトリを作る
        const base = dirname(repoDir);
        outsideFile = join(base, 'outside-secret.txt');
        outsideDir = join(base, 'outside-dir');
        await writeFile(outsideFile, `${OUTSIDE_SENTINEL}\n`);
        await mkdir(outsideDir, { recursive: true });
        await writeFile(join(outsideDir, OUTSIDE_INNER_NAME), `${OUTSIDE_SENTINEL}\n`);

        // リポジトリの外を指すシンボリックリンク(絶対、相対、ディレクトリ、多段)
        await symlink(outsideFile, join(repoDir, 'link-abs-file.txt'));
        await symlink('../outside-secret.txt', join(repoDir, 'link-rel-file.txt'));
        await symlink(outsideDir, join(repoDir, 'link-dir'));
        await symlink('link-abs-file.txt', join(repoDir, 'link-chain.txt'));
        await symlink('../../outside-secret.txt', join(repoDir, 'src/link-in-subdir.ts'));
      },
    });
  });

  afterAll(async () => {
    await stopIfStarted(server);
  });

  // path パラメータに入れる値(エンコード済み)。どれも、リポジトリの外のファイルを狙う
  const fileTraversals: Array<[label: string, query: string]> = [
    ['../', '../outside-secret.txt'],
    ['途中に ../ を挟む', 'src/../../outside-secret.txt'],
    ['./../', './../outside-secret.txt'],
    ['存在しないディレクトリを経由する', 'no-such-dir/../../outside-secret.txt'],
    ['%2e%2e%2f(エンコードされた ../)', '%2e%2e%2foutside-secret.txt'],
    ['..%2f', '..%2foutside-secret.txt'],
    ['%2E%2E/(大文字のエンコード)', '%2E%2E/outside-secret.txt'],
    ['二重エンコード(%252e%252e%252f)', '%252e%252e%252foutside-secret.txt'],
    ['バックスラッシュ(..%5c)', '..%5coutside-secret.txt'],
    ['....//(../ を1回だけ取り除く実装を狙う)', '....//outside-secret.txt'],
    ['NUL 文字を付ける(../…%00.md)', '../outside-secret.txt%00.md'],
    ['深い ../ で /etc/passwd', '../../../../../../../../etc/passwd'],
  ];

  it.each(fileTraversals)('S1-4: GET /api/file は %s を拒否する', async (_label, query) => {
    const res = await request(server, `/api/file?path=${query}`);
    expectRejected(res, `GET /api/file?path=${query}`, [OUTSIDE_SENTINEL, 'root:x:0:0']);
  });

  it('S1-4: GET /api/file は絶対パス(/etc/passwd)を拒否する', async () => {
    for (const query of ['/etc/passwd', '%2Fetc%2Fpasswd', '//etc/passwd', 'file:///etc/passwd']) {
      const res = await request(server, `/api/file?path=${query}`);
      expectRejected(res, `GET /api/file?path=${query}`, ['root:x:0:0']);
    }
  });

  it('S1-4: GET /api/file は絶対パス(リポジトリの外にあるファイル)を拒否する', async () => {
    const res = await request(server, `/api/file?path=${encodeURIComponent(outsideFile)}`);
    expectRejected(res, 'GET /api/file?path=<リポジトリ外の絶対パス>', [OUTSIDE_SENTINEL]);
  });

  const outsideLinks: Array<[label: string, path: string]> = [
    ['絶対パスのリンク', 'link-abs-file.txt'],
    ['相対パスのリンク', 'link-rel-file.txt'],
    ['リンクを経由するリンク', 'link-chain.txt'],
    ['サブディレクトリの中のリンク', 'src/link-in-subdir.ts'],
    ['ディレクトリへのリンクの配下', `link-dir/${OUTSIDE_INNER_NAME}`],
  ];

  it.each(outsideLinks)(
    'S1-4: GET /api/file は、リポジトリの外を指すシンボリックリンク(%s)を拒否する',
    async (_label, path) => {
      const res = await request(server, `/api/file?path=${encodeURIComponent(path)}`);
      expectRejected(res, `GET /api/file?path=${path}`, [OUTSIDE_SENTINEL]);
    }
  );

  const treeTraversals: Array<[label: string, query: string]> = [
    ['..', '..'],
    ['../', '../'],
    ['途中に ../ を挟む', 'src/../..'],
    ['%2e%2e(エンコードされた ..)', '%2e%2e'],
    ['../outside-dir', '../outside-dir'],
    ['..%2foutside-dir', '..%2foutside-dir'],
  ];

  it.each(treeTraversals)('S1-4: GET /api/tree は %s を拒否する', async (_label, query) => {
    const res = await request(server, `/api/tree?path=${query}`);
    expectRejected(res, `GET /api/tree?path=${query}`, [OUTSIDE_INNER_NAME, 'outside-secret.txt']);
  });

  it('S1-4: GET /api/tree は絶対パスを拒否する', async () => {
    const etc = await request(server, '/api/tree?path=/etc');
    expectRejected(etc, 'GET /api/tree?path=/etc', ['passwd']);

    const outside = await request(server, `/api/tree?path=${encodeURIComponent(outsideDir)}`);
    expectRejected(outside, 'GET /api/tree?path=<リポジトリ外の絶対パス>', [OUTSIDE_INNER_NAME]);
  });

  it('S1-4: GET /api/tree は、リポジトリの外を指すシンボリックリンク(ディレクトリ)を拒否する', async () => {
    const res = await request(server, '/api/tree?path=link-dir');
    expectRejected(res, 'GET /api/tree?path=link-dir', [OUTSIDE_INNER_NAME]);
  });

  it('S1-4: リポジトリ内の通常のパスは、/api/file と /api/tree で取得できる', async () => {
    const file = await request(server, '/api/file?path=src/example.ts');
    expect(file.status).toBe(200);
    expect(bodyContains(file.text, 'export function increment')).toBe(true);

    const root = await request(server, '/api/tree?path=');
    expect(root.status).toBe(200);
    expect(listsName(root.text, 'src'), 'ルートの一覧に src が無い').toBe(true);

    const sub = await request(server, '/api/tree?path=src');
    expect(sub.status).toBe(200);
    expect(listsName(sub.text, 'example.ts'), 'src の一覧に example.ts が無い').toBe(true);
  });
});

// ─── S1-5: 秘密ファイル・.gitignore の対象の除外 ──────────────────────────────

describe('S1-5: Secret files and .gitignore targets are hidden and rejected', () => {
  let server: TestServer;
  const denied = listDeniedFiles();
  /** 拒否対象でない親ディレクトリと、その一覧に必ず載っているはずの通常のファイル */
  const VISIBLE_SIBLINGS: Record<string, string | undefined> = {
    subdir: 'normal.ts',
    'subdir/nested': 'visible.txt',
    reports: '2026-10-12-feature.md',
  };

  beforeAll(async () => {
    server = await startTestServer({
      setup: async (repoDir) => {
        await createDeniedFiles(repoDir);
        // リポジトリ内の秘密ファイルを指す、無害な名前のシンボリックリンク
        await symlink('.env', join(repoDir, 'notes-link.txt'));
        // 通常のファイル(一覧に載り、取得できることの確認用)
        await writeFile(join(repoDir, 'subdir/nested/visible.txt'), 'E2E_VISIBLE_NESTED_FILE\n');
      },
    });
  });

  afterAll(async () => {
    await stopIfStarted(server);
  });

  it.each(denied)('S1-5: GET /api/file は $path を拒否する($reason)', async ({ path, sentinel }) => {
    const res = await request(server, `/api/file?path=${encodeURIComponent(path)}`);
    expectRejected(res, `GET /api/file?path=${path}`, [sentinel]);
  });

  it.each(denied)('S1-5: GET /api/tree の一覧に $path が出ない($reason)', async ({ path }) => {
    const segments = path.split('/');
    const name = segments[segments.length - 1] as string;
    const parent = segments.slice(0, -1).join('/');

    // ルートの一覧(再帰的に返す実装でも、1階層だけ返す実装でも、載っていてはいけない)
    const root = await request(server, '/api/tree?path=');
    expect(root.status).toBe(200);
    expect(listsName(root.text, 'src'), 'ルートの一覧に src が無い(一覧が空では検証にならない)').toBe(true);
    expect(listsName(root.text, path), `ルートの一覧に ${path} が載っている`).toBe(false);

    if (parent === '') return;
    const res = await request(server, `/api/tree?path=${encodeURIComponent(parent)}`);
    const sibling = VISIBLE_SIBLINGS[parent];
    if (sibling !== undefined) {
      // 親が拒否対象でないなら、一覧は 200 で返り、通常のファイルは載っている(一覧が空では検証にならない)
      expect(res.status, `GET /api/tree?path=${parent} が ${res.status} を返した`).toBe(200);
      expect(listsName(res.text, sibling), `${parent} の一覧に ${sibling} が無い`).toBe(true);
    } else {
      // 親そのものが拒否対象(.git、build-out)なら、4xx で拒否されてもよい
      expect(res.status, `GET /api/tree?path=${parent} が ${res.status} を返した`).toBeLessThan(500);
    }
    expect(listsName(res.text, name), `${parent} の一覧に ${name} が載っている`).toBe(false);
  });

  it('S1-5: GET /api/tree の一覧に .git と、.gitignore で除外されたディレクトリが出ない', async () => {
    const root = await request(server, '/api/tree?path=');
    expect(root.status).toBe(200);
    expect(listsName(root.text, 'src'), 'ルートの一覧に src が無い(一覧が空では検証にならない)').toBe(true);
    expect(listsName(root.text, 'subdir'), 'ルートの一覧に subdir が無い').toBe(true);
    expect(listsName(root.text, '.git')).toBe(false);
    expect(listsName(root.text, 'build-out')).toBe(false);
  });

  it.each(['.git', '.git/', 'build-out'])('S1-5: GET /api/tree は %s の中身を返さない', async (path) => {
    const res = await request(server, `/api/tree?path=${encodeURIComponent(path)}`);
    expectRejected(res, `GET /api/tree?path=${path}`);
    for (const name of ['config', 'HEAD', 'artifact.txt']) {
      expect(listsName(res.text, name), `${path} の一覧に ${name} が載っている`).toBe(false);
    }
  });

  // .env(目印は denied[0])を、パスの書き方を変えて取得しようとする
  const envVariants: Array<[label: string, query: string]> = [
    ['./.env', './.env'],
    ['src/../.env', 'src/../.env'],
    ['.git/../.env', '.git/../.env'],
    ['subdir//../.env', 'subdir//../.env'],
    ['%2eenv(エンコードされた .)', '%2eenv'],
    ['.env/(末尾のスラッシュ)', '.env/'],
    ['.env%00.md(NUL 文字を付ける)', '.env%00.md'],
    ['.ENV(大文字)', '.ENV'],
    ['.git%2fconfig', '.git%2fconfig'],
    ['.GIT/config(大文字)', '.GIT/config'],
    ['src/../.git/config', 'src/../.git/config'],
  ];

  it.each(envVariants)('S1-5: パスの書き方を変えても、秘密ファイルの中身は返らない(%s)', async (_label, query) => {
    const res = await request(server, `/api/file?path=${query}`);
    expectRejected(res, `GET /api/file?path=${query}`, denied.map((d) => d.sentinel));
  });

  it('S1-5: 秘密ファイルを指すリポジトリ内のシンボリックリンク経由でも、中身は返らない', async () => {
    const res = await request(server, '/api/file?path=notes-link.txt');
    expectRejected(res, 'GET /api/file?path=notes-link.txt', denied.map((d) => d.sentinel));
  });

  it('S1-5: .gitignore で除外されたレポートは GET /api/reports の一覧に出ない', async () => {
    const res = await request(server, '/api/reports');
    expect(res.status).toBe(200);
    expect(res.text).toContain('2026-10-12-feature.md');
    expect(res.text).not.toContain('2026-12-31-ignored');
  });

  it('S1-5: 拒否対象でない通常のファイルは、一覧に載り、取得できる', async () => {
    const tree = await request(server, '/api/tree?path=subdir');
    expect(tree.status).toBe(200);
    expect(listsName(tree.text, 'normal.ts'), 'subdir の一覧に normal.ts が無い').toBe(true);

    const nested = await request(server, '/api/tree?path=subdir/nested');
    expect(nested.status).toBe(200);
    expect(listsName(nested.text, 'visible.txt'), 'subdir/nested の一覧に visible.txt が無い').toBe(true);

    const file = await request(server, '/api/file?path=subdir/nested/visible.txt');
    expect(file.status).toBe(200);
    expect(bodyContains(file.text, 'E2E_VISIBLE_NESTED_FILE')).toBe(true);
  });
});

// ─── S1-6: 巨大ファイル・バイナリ ─────────────────────────────────────────────

describe('S1-6: Large and binary files do not return their content', () => {
  let server: TestServer;
  const LARGE_MARKER = 'E2E_LARGE_FILE_MARKER';
  const SMALL_MARKER = 'E2E_UNDER_LIMIT_FILE_MARKER';
  const BINARY_MARKER = 'E2E_BINARY_FILE_MARKER';

  beforeAll(async () => {
    server = await startTestServer({
      setup: async (repoDir) => {
        // 1MB を明らかに超えるテキスト(約 2MB)
        const line = `${LARGE_MARKER} ${'x'.repeat(77)}\n`; // 100 バイト
        await writeFile(join(repoDir, 'large-file.txt'), line.repeat(20_000));

        // 1MB を明らかに下回るテキスト(約 0.5MB)。「1MB」が 10^6 でも 2^20 でも上限以下
        const smallLine = `${SMALL_MARKER} ${'y'.repeat(71)}\n`; // 100 バイト
        await writeFile(join(repoDir, 'under-limit.txt'), smallLine.repeat(5_000));

        // バイナリ(PNG の先頭バイト列 + NUL を含むデータ + 目印)
        const binary = Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
          Buffer.from(BINARY_MARKER, 'ascii'),
          Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x01, 0x02, 0x80, 0x81]),
        ]);
        await writeFile(join(repoDir, 'image.png'), binary);
        // 拡張子はテキストに見えるが、中身はバイナリ
        await writeFile(join(repoDir, 'binary-data.txt'), binary);
      },
    });
  });

  afterAll(async () => {
    await stopIfStarted(server);
  });

  it('S1-6: 1MB を超えるファイルは、本文を返さない', async () => {
    const res = await request(server, '/api/file?path=large-file.txt');
    // 暫定: SPEC §2.2 はステータスコードを指定していないため、5xx でなければ受け入れる。
    // ユーザー確認済み(2026-10-12): 実装が 200 以外を返す場合は SPEC に追記してからこのテストを調整すること
    expect(res.status, `サーバーエラー(${res.status})になった`).toBeLessThan(500);
    expect(bodyContains(res.text, LARGE_MARKER), '巨大ファイルの本文が応答に含まれている').toBe(false);
    expect(res.body.length, '応答が 1MB 以上ある').toBeLessThan(1024 * 1024);
  });

  it.each(['image.png', 'binary-data.txt'])('S1-6: バイナリ(%s)は、本文を返さない', async (path) => {
    const res = await request(server, `/api/file?path=${path}`);
    // 暫定: 上と同じく SPEC §2.2 はステータスコードを指定していないため、5xx でなければ受け入れる
    expect(res.status, `サーバーエラー(${res.status})になった`).toBeLessThan(500);
    expect(bodyContains(res.text, BINARY_MARKER), 'バイナリの中身が応答に含まれている').toBe(false);
    // 生のバイト列としても返っていない
    expect(res.body.includes(Buffer.from(BINARY_MARKER, 'ascii'))).toBe(false);
    // Base64 にして返すのも「本文を返す」にあたる
    const base64 = Buffer.from(BINARY_MARKER, 'ascii').toString('base64').replace(/=+$/, '');
    expect(bodyContains(res.text, base64.slice(0, 24)), 'バイナリの中身が Base64 で応答に含まれている').toBe(false);
  });

  it.each(['large-file.txt', 'image.png'])(
    'S1-6: %s への応答は「その旨」を伝える(存在しないファイルへの応答と区別できる)',
    async (path) => {
      const res = await request(server, `/api/file?path=${path}`);
      const missing = await request(server, `/api/file?path=no-such-${path}`);
      // ステータスも本文も同じなら、「巨大・バイナリである」という旨が伝わっていない
      /**
       * 応答に含まれる「存在しないほうのパス」を、比較のために元のパスへ読み替える
       * @param text 応答ボディ
       * @returns 読み替えた後の文字列
       */
      const normalize = (text: string): string => text.replaceAll(`no-such-${path}`, path);
      const same = res.status === missing.status && normalize(res.text) === normalize(missing.text);
      expect(same, `存在しないファイルへの応答と同じ(${res.status}: ${res.text.slice(0, 200)})`).toBe(false);
    }
  );

  it('S1-6: 上限以下のテキストファイル(約 0.5MB)は、本文が返る', async () => {
    const res = await request(server, '/api/file?path=under-limit.txt');
    expect(res.status).toBe(200);
    expect(bodyContains(res.text, SMALL_MARKER)).toBe(true);
  });

  it('S1-6: 通常の小さいファイルは、本文が返る', async () => {
    const res = await request(server, '/api/file?path=src/example.ts');
    expect(res.status).toBe(200);
    expect(bodyContains(res.text, 'export function increment')).toBe(true);
  });

  // SPEC の曖昧点(人間への質問として報告済み): 「1MB」が 1,000,000 バイトか 1,048,576 バイトか
  it.todo('S1-6: ちょうど上限のファイルは本文が返り、上限を 1 バイト超えると返らない(上限の定義が未確定)');
});
