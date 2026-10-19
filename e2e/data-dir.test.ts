/**
 * e2e 保存先テスト(ステージ2 / B1: 保存先の決め方と、対象リポジトリの不変)
 * 対象基準: S2-8(保存先以外に書き込まない)、S2-9(保存先の決め方と、使えないときの終了)
 *
 * 公開インターフェース(`npm start [-- <引数>]`、環境変数、終了コード、出力、HTTP、保存先のファイル)だけを使う。
 * SPEC §2.1(保存先の `comments.json`)、§2.5「保存先の決め方」、§5 を根拠とする。src/ は読まない。
 *
 * 実ユーザーの /tmp を汚さないため、TMPDIR は常に e2e 用の一時ディレクトリに向ける。
 * S2-9 の (d)〜(f) は `/data` が存在しない環境でだけ成り立つ。存在する環境(コンテナなど)では飛ばす。
 */

import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { commentsOf, getComments, jsonOf, postComment } from './helpers/comments.js';
import { request, waitUntil } from './helpers/http.js';
import {
  cleanupLaunched,
  launchApp,
  makeTmpDir,
  observeRefusal,
  restorePermissions,
  type Launched,
} from './helpers/launch.js';
import { FIXTURES_REPO, startTestServer, stopIfStarted, type TestServer } from './helpers/server.js';
import { snapshotTree } from './helpers/snapshot.js';

const DUMMY_TOKEN = 'E2E_DUMMY_TOKEN_NOT_A_REAL_SECRET_S29';
const EXAMPLE = 'src/example.ts';
const IS_ROOT = process.getuid?.() === 0;
const UID = process.getuid?.() ?? 0;

afterEach(async () => {
  await cleanupLaunched();
});

/**
 * 有効な作成リクエストを作る
 * @param body コメント本文
 * @returns リクエストの JSON
 */
function valid(body = 'e2e comment'): Record<string, unknown> {
  return { path: EXAMPLE, startLine: 1, endLine: 1, body, type: 'note' };
}

/**
 * 一時ディレクトリの中に、フィクスチャのリポジトリのコピー(repo)と TMPDIR 用の空ディレクトリ(tmp)を作る
 * @returns base(親)、repo、tmp
 */
async function prepare(): Promise<{ base: string; repo: string; tmp: string }> {
  const base = await makeTmpDir('rv-e2e-dd-');
  const repo = join(base, 'repo');
  const tmp = join(base, 'tmp');
  await cp(FIXTURES_REPO, repo, { recursive: true, verbatimSymlinks: true });
  await mkdir(tmp, { recursive: true });
  return { base, repo, tmp };
}

/**
 * 起動できて、コメントを1件作れることを確かめる
 * @param l 起動した試行
 * @param body コメント本文
 * @returns 作成したコメントの ID
 */
async function createViaLaunched(l: Launched, body = 'e2e comment'): Promise<string> {
  expect(await l.waitReady(), `起動しませんでした。出力:\n${l.output()}`).toBe(true);
  const res = await postComment(l, valid(body));
  expect(res.status, res.text).toBe(201);
  return jsonOf(res).id as string;
}

/**
 * 待ち受けを始めずに、理由を示して、終了コード 0 以外で終了したことを検証する
 * @param l 起動した試行
 * @returns なし
 */
async function expectRefused(l: Launched, goodDataDir?: string): Promise<void> {
  const r = await observeRefusal(l);
  expect(r.exit, `20 秒以内に終了しませんでした。出力:\n${r.output}`).not.toBeNull();
  expect(r.exit?.code === 0, `終了コードが 0 でした。出力:\n${r.output}`).toBe(false);
  expect(r.output.trim().length, '理由が出力されていません').toBeGreaterThan(0);
  expect(r.listening, '待ち受けを始めています').toBe(false);
  expect(r.output, 'C-5: トークンを出力に含めない').not.toContain(DUMMY_TOKEN);
  if (goodDataDir !== undefined) {
    // 指定が使えないときに、次の候補(環境変数 DATA_DIR)へ進んでいない
    expect(await listOrNull(goodDataDir), '次の候補(DATA_DIR)へ進んでいる').toEqual([]);
  }
}

/**
 * 「使える」保存先(空のディレクトリ)を作る。--data-dir が使えないときに、ここへ進まないことの確認に使う
 * @param base 一時ディレクトリの親
 * @returns 作ったディレクトリのパス
 */
async function makeGood(base: string): Promise<string> {
  const dir = join(base, 'good-data');
  await mkdir(dir);
  return dir;
}

/**
 * ディレクトリの中身の名前一覧(無ければ null)
 * @param dir ディレクトリ
 * @returns 名前の配列。ディレクトリが無ければ null
 */
async function listOrNull(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * TMPDIR の中の、保存先に見えるもの(review-viewer-*)の名前一覧
 * (Node.js 自身が TMPDIR に compile cache を作ることがあるので、ディレクトリ全体が空かどうかは見ない)
 * @param tmp TMPDIR
 * @returns review-viewer- で始まる名前の配列
 */
async function storeLikeEntries(tmp: string): Promise<string[]> {
  return ((await listOrNull(tmp)) ?? []).filter((n) => n.startsWith('review-viewer'));
}

/**
 * ファイルが現れるのを待つ
 * @param path ファイルのパス
 * @returns 現れたら true
 */
function appears(path: string): Promise<boolean> {
  return waitUntil(() => existsSync(path), 5_000, 100);
}

// ─── S2-9 (a)(b): 指定した保存先が使われる ─────────────────────────────────

describe('S2-9: 保存先の決め方(指定)', () => {
  describe('(a) --data-dir が環境変数 DATA_DIR より優先される', () => {
    let server: TestServer;
    let argDir = '';
    let envDir = '';
    let tmpDir = '';

    beforeAll(async () => {
      server = await startTestServer({
        omitEnv: ['DATA_DIR'],
        args: ['{repo}', '--data-dir', '{base}/arg-data'],
        env: { DATA_DIR: '{base}/env-data', TMPDIR: '{base}/tmp' },
        setup: async (repoDir) => {
          const base = join(repoDir, '..');
          argDir = join(base, 'arg-data');
          envDir = join(base, 'env-data');
          tmpDir = join(base, 'tmp');
          await mkdir(argDir);
          await mkdir(envDir);
          await mkdir(tmpDir);
        },
      });
    });
    afterAll(async () => {
      await stopIfStarted(server);
    });

    it('S2-9: --data-dir で指定した保存先にコメントが保存され、DATA_DIR の保存先は使われない', async () => {
      const res = await postComment(server, valid('S2-9 (a)'));
      expect(res.status, res.text).toBe(201);
      expect(await appears(join(argDir, 'comments.json')), `${argDir} に comments.json が無い`).toBe(true);
      expect(existsSync(join(envDir, 'comments.json')), 'DATA_DIR 側に書いている').toBe(false);
      expect(await listOrNull(envDir)).toEqual([]);
      expect(await storeLikeEntries(tmpDir), '一時ディレクトリに保存先を作っている').toEqual([]);
    });

    it('S2-9: --data-dir を使った起動は、再起動しても同じ保存先のコメントが残る', async () => {
      const created = jsonOf(await postComment(server, valid('S2-9 (a) 再起動')));
      await server.restart();
      const list = commentsOf(await getComments(server));
      expect(list.map((c) => c.id)).toContain(created.id);
    });
  });

  it('S2-9: --data-dir の相対パスは、起動したディレクトリ(npm 経由なら INIT_CWD)を基準にする', async () => {
    const { base, repo, tmp } = await prepare();
    await mkdir(join(base, 'rel-data'));
    // アプリのルートとは別のディレクトリ(base)で `npm --prefix <APP_DIR> start -- repo --data-dir rel-data` を実行する
    const l = await launchApp({
      prefix: true,
      cwd: base,
      args: ['repo', '--data-dir', 'rel-data'],
      env: { TMPDIR: tmp },
    });
    void repo;
    await createViaLaunched(l, 'S2-9 相対');
    expect(await appears(join(base, 'rel-data', 'comments.json')), 'base/rel-data/comments.json が無い').toBe(true);
    expect(await storeLikeEntries(tmp), '一時ディレクトリに保存先を作っている').toEqual([]);
  });

  it('S2-9: (b) 環境変数 DATA_DIR で指定した保存先が使われる', async () => {
    const { base, repo, tmp } = await prepare();
    const dataDir = join(base, 'env-data');
    await mkdir(dataDir);
    const l = await launchApp({ env: { REPO_DIR: repo, DATA_DIR: dataDir, TMPDIR: tmp } });
    await createViaLaunched(l, 'S2-9 (b)');
    expect(await appears(join(dataDir, 'comments.json')), `${dataDir} に comments.json が無い`).toBe(true);
    expect(await storeLikeEntries(tmp), '一時ディレクトリに保存先を作っている').toEqual([]);
  });
});

// ─── S2-9 (c): 指定した保存先が使えない → 終了し、次の候補へ進まない ─────────

describe('S2-9: (c) 指定した保存先が使えないときは、待ち受けずに終了し、次の候補へ進まない', () => {
  it('S2-9: --data-dir がファイルなら終了する(DATA_DIR が正しくても次へ進まない)', async () => {
    const { base, repo, tmp } = await prepare();
    const file = join(base, 'a-file');
    await writeFile(file, 'ディレクトリではない\n');
    const good = join(base, 'good-data');
    await mkdir(good);
    const l = await launchApp({
      args: [repo, '--data-dir', file],
      env: { DATA_DIR: good, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
    });
    await expectRefused(l);
    expect(await listOrNull(good), '次の候補(DATA_DIR)へ進んでいる').toEqual([]);
    expect(await storeLikeEntries(tmp), '次の候補(一時ディレクトリ)へ進んでいる').toEqual([]);
  });

  it('S2-9: DATA_DIR がファイルなら終了する(一時ディレクトリへ進まない)', async () => {
    const { base, repo, tmp } = await prepare();
    const file = join(base, 'a-file');
    await writeFile(file, 'ディレクトリではない\n');
    const l = await launchApp({
      env: { REPO_DIR: repo, DATA_DIR: file, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
    });
    await expectRefused(l);
    expect(await storeLikeEntries(tmp), '次の候補(一時ディレクトリ)へ進んでいる').toEqual([]);
  });

  it('S2-9: --data-dir の親がファイルで作れないなら終了する', async () => {
    const { base, repo, tmp } = await prepare();
    const good = await makeGood(base);
    const file = join(base, 'a-file');
    await writeFile(file, 'ディレクトリではない\n');
    const l = await launchApp({
      args: [repo, '--data-dir', join(file, 'child')],
      env: { DATA_DIR: good, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
    });
    await expectRefused(l, good);
    expect(await storeLikeEntries(tmp)).toEqual([]);
  });

  it.skipIf(IS_ROOT)('S2-9: --data-dir が書き込めないディレクトリなら終了する(root では権限で防げないため飛ばす)', async () => {
    const { base, repo, tmp } = await prepare();
    const good = await makeGood(base);
    const ro = join(base, 'ro-data');
    await mkdir(ro);
    await chmod(ro, 0o500);
    const l = await launchApp({
      args: [repo, '--data-dir', ro],
      env: { DATA_DIR: good, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
    });
    await expectRefused(l, good);
    expect(await storeLikeEntries(tmp), '次の候補へ進んでいる').toEqual([]);
    await restorePermissions(ro);
  });

  it.skipIf(IS_ROOT)('S2-9: DATA_DIR が書き込めないディレクトリなら終了する(root では飛ばす)', async () => {
    const { base, repo, tmp } = await prepare();
    const ro = join(base, 'ro-data');
    await mkdir(ro);
    await chmod(ro, 0o500);
    const l = await launchApp({
      env: { REPO_DIR: repo, DATA_DIR: ro, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
    });
    await expectRefused(l);
    expect(await storeLikeEntries(tmp), '次の候補へ進んでいる').toEqual([]);
    await restorePermissions(ro);
  });

  describe('対象リポジトリの中にある保存先', () => {
    it('S2-9: --data-dir が対象リポジトリの中のディレクトリなら終了する', async () => {
      const { repo, tmp, base } = await prepare();
    const good = await makeGood(base);
      const before = await snapshotTree(repo);
      const l = await launchApp({
        args: [repo, '--data-dir', join(repo, 'subdir')],
        env: { DATA_DIR: good, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
      });
      await expectRefused(l, good);
      expect(await snapshotTree(repo), '対象リポジトリが変わった').toEqual(before);
    });

    it('S2-9: --data-dir が対象リポジトリの中の、まだ無いディレクトリなら、作らずに終了する', async () => {
      const { repo, tmp, base } = await prepare();
    const good = await makeGood(base);
      const before = await snapshotTree(repo);
      const l = await launchApp({
        args: [repo, '--data-dir', join(repo, 'new-data')],
        env: { DATA_DIR: good, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
      });
      await expectRefused(l, good);
      expect(existsSync(join(repo, 'new-data')), '対象リポジトリの中に作った').toBe(false);
      expect(await snapshotTree(repo)).toEqual(before);
    });

    it('S2-9: --data-dir が対象リポジトリそのものなら終了する', async () => {
      const { repo, tmp, base } = await prepare();
    const good = await makeGood(base);
      const l = await launchApp({
        args: [repo, '--data-dir', repo],
        env: { DATA_DIR: good, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
      });
      await expectRefused(l, good);
    });

    it('S2-9: DATA_DIR が対象リポジトリの中なら終了する', async () => {
      const { repo, tmp } = await prepare();
      const l = await launchApp({
        env: { REPO_DIR: repo, DATA_DIR: join(repo, 'subdir'), TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
      });
      await expectRefused(l);
      expect(await storeLikeEntries(tmp), '次の候補へ進んでいる').toEqual([]);
    });

    it('S2-9: 対象リポジトリの中を指すシンボリックリンクを保存先にしても終了する', async () => {
      const { base, repo, tmp } = await prepare();
    const good = await makeGood(base);
      const link = join(base, 'link-to-repo-subdir');
      await symlink(join(repo, 'subdir'), link);
      const l = await launchApp({
        args: [repo, '--data-dir', link],
        env: { DATA_DIR: good, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
      });
      await expectRefused(l, good);
    });

    it('S2-9: 相対パスで対象リポジトリの中を指しても終了する(起動したディレクトリ基準)', async () => {
      const { base, tmp } = await prepare();
    const good = await makeGood(base);
      const l = await launchApp({
        prefix: true,
        cwd: base,
        args: ['repo', '--data-dir', 'repo/subdir'],
        env: { DATA_DIR: good, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN },
      });
      await expectRefused(l, good);
    });
  });
});

// ─── S2-8: 保存先以外に書き込まない ─────────────────────────────────────────

describe('S2-8: 保存先以外に書き込まない(対象リポジトリは操作の前後で変わらない)', () => {
  /**
   * 起動、作成、不正な作成、取得、閲覧 API、終了を通して実行する
   * @param base 一時ディレクトリの親
   * @param repo 対象リポジトリ
   * @param tmp TMPDIR
   * @param dataDir 保存先
   * @returns なし
   */
  async function exercise(base: string, repo: string, tmp: string, dataDir: string): Promise<void> {
    const l = await launchApp({ env: { REPO_DIR: repo, DATA_DIR: dataDir, TMPDIR: tmp } });
    await createViaLaunched(l, 'S2-8');
    expect((await postComment(l, valid('S2-8 2件目'))).status).toBe(201);
    expect((await postComment(l, { ...valid(), path: '../x' })).status).toBe(400);
    expect((await postComment(l, { ...valid(), path: 'no/such' })).status).toBe(404);
    expect((await getComments(l)).status).toBe(200);
    expect((await request(l, '/api/reports')).status).toBe(200);
    expect((await request(l, '/api/tree?path=')).status).toBe(200);
    expect((await request(l, `/api/file?path=${EXAMPLE}`)).status).toBe(200);
    const exit = await l.stop();
    expect(exit, `SIGTERM で終了しませんでした。出力:\n${l.output()}`).not.toBeNull();
    void base;
  }

  it('S2-8: 起動・作成・取得・終了(2回)を通して、対象リポジトリのファイルは変わらない', async () => {
    const { base, repo, tmp } = await prepare();
    const dataDir = join(base, 'data');
    await mkdir(dataDir);
    const before = await snapshotTree(repo);
    await exercise(base, repo, tmp, dataDir);
    expect(await snapshotTree(repo), '1回目の後で対象リポジトリが変わった').toEqual(before);
    await exercise(base, repo, tmp, dataDir); // 再起動
    expect(await snapshotTree(repo), '2回目の後で対象リポジトリが変わった').toEqual(before);
    expect(await appears(join(dataDir, 'comments.json')), '保存先に comments.json が無い').toBe(true);
    expect(await storeLikeEntries(tmp), '保存先以外(TMPDIR)に書いている').toEqual([]);
    expect((await readdir(base)).sort(), '一時ディレクトリの親に余計なものができた').toEqual(['data', 'repo', 'tmp']);
  });

  it('S2-8: 対象リポジトリを書き込み禁止にしても、起動・作成・取得・終了が成功する', async () => {
    const { base, repo, tmp } = await prepare();
    const dataDir = join(base, 'data');
    await mkdir(dataDir);
    const before = await snapshotTree(repo);
    /**
     * 再帰的に書き込み権限を外す
     * @param p 対象
     * @returns なし
     */
    const lock = async (p: string): Promise<void> => {
      const st = await lstat(p);
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        for (const n of await readdir(p)) await lock(join(p, n));
        await chmod(p, 0o555);
      } else {
        await chmod(p, 0o444);
      }
    };
    await lock(repo);
    try {
      const l = await launchApp({ env: { REPO_DIR: repo, DATA_DIR: dataDir, TMPDIR: tmp } });
      const id = await createViaLaunched(l, 'S2-8 読み取り専用');
      const list = commentsOf(await getComments(l));
      expect(list.map((c) => c.id)).toContain(id);
      expect(await l.stop(), `終了しませんでした。出力:\n${l.output()}`).not.toBeNull();
    } finally {
      await restorePermissions(repo);
    }
    expect(await snapshotTree(repo)).toEqual(before);
    expect(await appears(join(dataDir, 'comments.json'))).toBe(true);
  });
});

// ─── S2-9 (d)(e)(f): 一時ディレクトリの既定の保存先 ──────────────────────────

const noDataDir = !existsSync('/data');
if (!noDataDir) {
  console.info(
    'S2-9 (d)〜(f) を飛ばします: /data が存在する環境(コンテナなど)では、' +
      '「引数・環境変数なしで一時ディレクトリが使われる」という前提が成り立たないため'
  );
}
const itTmp = it.skipIf(!noDataDir);
const tmpName = `review-viewer-${UID}`;

describe('S2-9: (d)〜(f) 既定の保存先(OS の一時ディレクトリ。/data が無い環境のみ)', () => {
  describe('(d)(f) 作成と再利用', () => {
    let server: TestServer;
    let tmpDir = '';

    beforeAll(async () => {
      if (!noDataDir) return;
      server = await startTestServer({
        omitEnv: ['DATA_DIR'],
        env: { TMPDIR: '{base}/tmp' },
        setup: async (repoDir) => {
          tmpDir = join(repoDir, '..', 'tmp');
          await mkdir(tmpDir);
        },
      });
    });
    afterAll(async () => {
      await stopIfStarted(server);
    });

    itTmp(`S2-9: (d) 引数・環境変数なしなら、TMPDIR/${tmpName} が 0700 で作られ、そこにコメントが保存される`, async () => {
      const res = await postComment(server, valid('S2-9 (d)'));
      expect(res.status, res.text).toBe(201);
      const dir = join(tmpDir, tmpName);
      expect(await appears(join(dir, 'comments.json')), `${dir}/comments.json が無い`).toBe(true);
      const st = await lstat(dir);
      expect(st.isDirectory() && !st.isSymbolicLink()).toBe(true);
      expect(st.mode & 0o777, '権限が 0700 でない').toBe(0o700);
      expect(st.uid).toBe(UID);
      // 使われなかった DATA_DIR 用の一時ディレクトリには書かない
      expect(existsSync(join(server.dataDir, 'comments.json'))).toBe(false);
    });

    itTmp('S2-9: (d) 起動時の出力に「一時的な保存先」の旨が出る', async () => {
      expect(server.logs()).toContain('一時的な保存先');
    });

    itTmp('S2-9: (f) 自分で作った 0700 のものは、再起動しても再利用され、コメントが残る', async () => {
      const created = jsonOf(await postComment(server, valid('S2-9 (f)')));
      await server.restart();
      const list = commentsOf(await getComments(server));
      expect(list.map((c) => c.id)).toContain(created.id);
      expect((await lstat(join(tmpDir, tmpName))).mode & 0o777).toBe(0o700);
    });
  });

  itTmp('S2-9: (f) すでにある 0700・自分の所有のディレクトリは、そのまま使われる', async () => {
    const { repo, tmp } = await prepare();
    const dir = join(tmp, tmpName);
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
    const l = await launchApp({ env: { REPO_DIR: repo, TMPDIR: tmp } });
    await createViaLaunched(l, 'S2-9 (f) 既存');
    expect(await appears(join(dir, 'comments.json'))).toBe(true);
  });

  const loose: Array<[label: string, mode: number]> = [
    ['0755', 0o755],
    ['0777', 0o777],
    ['0750(グループに権限)', 0o750],
    ['0705(他人に権限)', 0o705],
  ];
  itTmp.each(loose)('S2-9: (e) 既存のものの権限が緩い(%s)なら、待ち受けずに終了する', async (_label, mode) => {
    const { repo, tmp } = await prepare();
    const dir = join(tmp, tmpName);
    await mkdir(dir);
    await chmod(dir, mode);
    const l = await launchApp({ env: { REPO_DIR: repo, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN } });
    await expectRefused(l);
    expect(existsSync(join(dir, 'comments.json')), '安全でない保存先に書いている').toBe(false);
  });

  itTmp('S2-9: (e) 既存のものがシンボリックリンク(リンク先は 0700・自分の所有)でも、待ち受けずに終了する', async () => {
    const { base, repo, tmp } = await prepare();
    const target = join(base, 'link-target');
    await mkdir(target, { mode: 0o700 });
    await chmod(target, 0o700);
    await symlink(target, join(tmp, tmpName));
    const l = await launchApp({ env: { REPO_DIR: repo, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN } });
    await expectRefused(l);
    expect(await listOrNull(target), 'リンク先に書いている').toEqual([]);
  });

  itTmp('S2-9: (e) 既存のものがシンボリックリンク(壊れたリンク)でも、待ち受けずに終了し、リンク先を作らない', async () => {
    const { base, repo, tmp } = await prepare();
    const target = join(base, 'not-yet');
    await symlink(target, join(tmp, tmpName));
    const l = await launchApp({ env: { REPO_DIR: repo, TMPDIR: tmp, REVIEW_VIEWER_TOKEN: DUMMY_TOKEN } });
    await expectRefused(l);
    expect(existsSync(target), 'リンク先を作った').toBe(false);
  });
});
