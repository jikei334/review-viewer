/**
 * S1-10: 対象リポジトリの決め方(SPEC §2.5)のシステムテスト
 *
 * 公開インターフェース(`npm start [-- <パス>]`、環境変数、終了コード、出力、HTTP)だけを使う。
 * 標準入力は常に /dev/null(端末ではない)にする。端末での対話入力(§2.5 の 4)は、
 * 擬似端末が必要なため、ここでは検証しない(手動確認)。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canConnect, request, waitUntil } from './helpers/http.js';
import { APP_DIR, FIXTURES_REPO } from './helpers/server.js';

/** テスト用に除去する、SPEC §2.5 の環境変数 */
const SPEC_ENV_NAMES = [
  'REPO_DIR',
  'DATA_DIR',
  'HOST',
  'PORT',
  'REVIEW_VIEWER_TOKEN',
  'ALLOWED_HOSTS',
  'ALLOWED_ORIGINS',
] as const;

// 暫定: SPEC は終了までの待ち時間を指定していないため、20 秒以内に終了することを仮定
const EXIT_TIMEOUT_MS = 20_000;

/** ダミーのトークン。理由のメッセージに出てはいけない(C-5) */
const DUMMY_TOKEN = 'E2E_DUMMY_TOKEN_NOT_A_REAL_SECRET_S110';

/** 起動した試行 */
interface Launch {
  port: number;
  /** 標準出力と標準エラーの連結(暫定: SPEC は出力先を指定していないため、両方を対象にする) */
  output: () => string;
  /** 終了を待つ。時間内に終了しなければ null */
  waitExit: (timeoutMs?: number) => Promise<{ code: number | null; signal: string | null } | null>;
  kill: () => void;
}

const launched: Launch[] = [];
const tmpDirs: string[] = [];

/**
 * 空きポートを取得する
 * @returns ポート番号
 */
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('空きポートを取得できませんでした')));
        return;
      }
      srv.close(() => resolvePort(addr.port));
    });
  });
}

/**
 * 一時ディレクトリを作る(afterEach で削除)
 * @returns パス
 */
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rv-e2e-startup-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * `npm start` を、標準入力を端末でなくして起動する
 *
 * @param opts.args `npm start --` の後ろに渡す引数
 * @param opts.repoDirEnv REPO_DIR に設定する値。undefined なら設定しない
 * @param opts.cwd 起動するディレクトリ。省略時はアプリのルート
 * @param opts.prefix true なら `npm --prefix <APP_DIR> start` で、アプリのルート以外から起動する
 * @returns 起動した試行
 */
async function launch(opts: {
  args?: string[];
  repoDirEnv?: string;
  cwd?: string;
  prefix?: boolean;
}): Promise<Launch> {
  const port = await freePort();
  const dataDir = join(await makeTmp(), 'data');
  await mkdir(dataDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SPEC_ENV_NAMES) delete env[name];
  env.DATA_DIR = dataDir;
  env.PORT = String(port);
  env.HOST = '127.0.0.1';
  env.REVIEW_VIEWER_TOKEN = DUMMY_TOKEN;
  if (opts.repoDirEnv !== undefined) env.REPO_DIR = opts.repoDirEnv;

  const npmArgs = opts.prefix ? ['--prefix', APP_DIR, 'start'] : ['start'];
  if (opts.args && opts.args.length > 0) npmArgs.push('--', ...opts.args);

  const child: ChildProcess = spawn('npm', npmArgs, {
    cwd: opts.cwd ?? APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  let exit: { code: number | null; signal: string | null } | null = null;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  const l: Launch = {
    port,
    output: () => out,
    waitExit: async (timeoutMs = EXIT_TIMEOUT_MS) => {
      await waitUntil(() => exit !== null, timeoutMs, 100);
      return exit;
    },
    kill: () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // すでに終了している場合は何もしない
      }
    },
  };
  launched.push(l);
  return l;
}

afterEach(async () => {
  for (const l of launched.splice(0)) l.kill();
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * 「待ち受けを始めずに、理由を示して、終了コード 0 以外で終了した」ことを検証する
 * @param l 起動した試行
 * @returns なし
 */
async function expectRefusedToStart(l: Launch): Promise<void> {
  const exit = await l.waitExit();
  expect(exit, `${EXIT_TIMEOUT_MS}ms 以内に終了しませんでした。出力:\n${l.output()}`).not.toBeNull();
  expect(exit?.code === 0, `終了コードが 0 でした。出力:\n${l.output()}`).toBe(false);
  expect(l.output().trim().length, '理由が出力されていません').toBeGreaterThan(0);
  expect(await canConnect('127.0.0.1', l.port, 500), '待ち受けを始めています').toBe(false);
  // C-5: トークンを理由に出さない
  expect(l.output()).not.toContain(DUMMY_TOKEN);
}

/**
 * 起動したサーバーが、指定のリポジトリを読んでいることを確かめる
 * @param l 起動した試行
 * @returns なし
 */
async function expectServesFixtureRepo(l: Launch): Promise<void> {
  const ready = await waitUntil(async () => {
    try {
      return (await request({ port: l.port }, '/healthz', { timeoutMs: 1_000 })).status === 200;
    } catch {
      return false;
    }
  }, 20_000, 200);
  expect(ready, `起動しませんでした。出力:\n${l.output()}`).toBe(true);
  const res = await request({ port: l.port }, '/api/reports');
  expect(res.status).toBe(200);
  // フィクスチャのレポート名が返る(形式の詳細には依存しない)
  expect(res.text).toContain('2026-10-12-feature.md');
}

// /repo が実在する環境(コンテナ内など)では、「引数も REPO_DIR も無ければ /repo」になるため、
// 「何も決まらない」前提が成り立たない。その1ケースだけを skip する(他は /repo の有無に関係しない)
const hasDefaultRepo = existsSync('/repo');

describe('S1-10: 対象リポジトリが決まらない・不正なときは、待ち受けずに終了する', () => {
  it.skipIf(hasDefaultRepo)(
    'S1-10: 引数も REPO_DIR も /repo も無く、標準入力が端末でないとき、終了コード 0 以外で終了する',
    async () => {
      await expectRefusedToStart(await launch({}));
    }
  );

  it('S1-10: REPO_DIR が存在しないパスのとき、終了コード 0 以外で終了する', async () => {
    const base = await makeTmp();
    await expectRefusedToStart(await launch({ repoDirEnv: join(base, 'no-such-dir') }));
  });

  it('S1-10: REPO_DIR がファイル(ディレクトリでない)のとき、終了コード 0 以外で終了する', async () => {
    const base = await makeTmp();
    const file = join(base, 'a-file.txt');
    await writeFile(file, 'ディレクトリではない\n');
    await expectRefusedToStart(await launch({ repoDirEnv: file }));
  });

  it('S1-10: 引数が存在しないパスのとき、終了コード 0 以外で終了する', async () => {
    const base = await makeTmp();
    await expectRefusedToStart(await launch({ args: [join(base, 'no-such-dir')] }));
  });

  it('S1-10: 引数がファイルのとき、終了コード 0 以外で終了する', async () => {
    const base = await makeTmp();
    const file = join(base, 'a-file.txt');
    await writeFile(file, 'ディレクトリではない\n');
    await expectRefusedToStart(await launch({ args: [file] }));
  });

  it('S1-10: 引数が不正なら、REPO_DIR が正しくても終了する(引数が優先され、入力にも進まない)', async () => {
    const base = await makeTmp();
    const good = join(base, 'repo');
    await cp(FIXTURES_REPO, good, { recursive: true, verbatimSymlinks: true });
    await expectRefusedToStart(
      await launch({ args: [join(base, 'no-such-dir')], repoDirEnv: good })
    );
  });

  it('S1-10: 引数が REPO_DIR より優先される(REPO_DIR が不正でも、引数が正しければ起動する)', async () => {
    const base = await makeTmp();
    const good = join(base, 'repo');
    await cp(FIXTURES_REPO, good, { recursive: true, verbatimSymlinks: true });
    const l = await launch({ args: [good], repoDirEnv: join(base, 'no-such-dir') });
    await expectServesFixtureRepo(l);
  });

  it('S1-10: REPO_DIR だけが正しいとき、そのリポジトリで起動する', async () => {
    const base = await makeTmp();
    const good = join(base, 'repo');
    await cp(FIXTURES_REPO, good, { recursive: true, verbatimSymlinks: true });
    await expectServesFixtureRepo(await launch({ repoDirEnv: good }));
  });

  it('S1-10: 相対パスの引数は、起動したディレクトリを基準に解決される', async () => {
    const base = await makeTmp();
    await cp(FIXTURES_REPO, join(base, 'myrepo'), { recursive: true, verbatimSymlinks: true });
    // アプリのルートとは別のディレクトリ(base)で `npm --prefix <APP_DIR> start -- myrepo` を実行する。
    // 起動したディレクトリ基準なら base/myrepo、アプリのルート基準なら存在しないパスになる
    const l = await launch({ args: ['myrepo'], cwd: base, prefix: true });
    await expectServesFixtureRepo(l);
  });

  it('S1-10: アプリのルートから起動したとき、相対パスの引数がそこを基準に解決される', async () => {
    const base = await makeTmp();
    const good = join(base, 'repo');
    await cp(FIXTURES_REPO, good, { recursive: true, verbatimSymlinks: true });
    const l = await launch({ args: [relative(APP_DIR, good)] });
    await expectServesFixtureRepo(l);
  });
});
