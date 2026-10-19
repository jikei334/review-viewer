/**
 * e2e テスト用の「素の起動」ヘルパー
 *
 * `startTestServer`(helpers/server.ts)は、起動に成功することを前提にしている。
 * こちらは、起動の失敗(待ち受けを始めず、終了コード 0 以外で終了する)や、
 * 起動引数・環境変数を細かく指定した起動、停止後も一時ディレクトリを残したい検証に使う。
 *
 * SPEC §2.5 の起動インターフェース(`npm start [-- <引数>]`、環境変数、GET /healthz、シグナル)だけを使う。
 */

import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canConnect, request, waitUntil } from './http.js';
import { APP_DIR, spawnNpm } from './server.js';

/** SPEC §2.5 の環境変数。実行者の環境から漏れ込まないように除去する */
const SPEC_ENV_NAMES = [
  'REPO_DIR',
  'DATA_DIR',
  'HOST',
  'PORT',
  'REVIEW_VIEWER_TOKEN',
  'ALLOWED_HOSTS',
  'ALLOWED_ORIGINS',
] as const;

/** 終了を待つ上限(ミリ秒)。SPEC は起動失敗の終了時間を指定していないため、暫定で 20 秒 */
export const EXIT_TIMEOUT_MS = 20_000;

/** 起動オプション */
export interface LaunchOptions {
  /** `npm start --` の後ろに渡す引数 */
  args?: string[];
  /** 追加の環境変数。値が undefined ならその変数を渡さない(SPEC_ENV_NAMES はいったん除去済み) */
  env?: Record<string, string | undefined>;
  /** 実行するディレクトリ。省略時はアプリのルート */
  cwd?: string;
  /** true なら `npm --prefix <APP_DIR> start` で、アプリのルート以外から起動する */
  prefix?: boolean;
  /** 使うポート。省略時は空きポートを取得する */
  port?: number;
}

/** 起動した試行 */
export interface Launched {
  port: number;
  /** 標準出力と標準エラーの連結 */
  output: () => string;
  /** 終了を待つ。時間内に終了しなければ null */
  waitExit: (timeoutMs?: number) => Promise<{ code: number | null; signal: string | null } | null>;
  /** GET /healthz が 200 になるのを待つ。時間内に 200 にならなければ false */
  waitReady: (timeoutMs?: number) => Promise<boolean>;
  /**
   * プロセスグループ全体に SIGTERM を送り、終了を待つ
   * @returns 終了の様子(時間内に終了しなければ null)
   */
  stop: () => Promise<{ code: number | null; signal: string | null } | null>;
  /** 強制終了する */
  kill: () => void;
}

const launched: Launched[] = [];
const tmpDirs: string[] = [];

/**
 * 空きポートを取得する
 * @returns ポート番号
 */
export async function freePort(): Promise<number> {
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
 * 一時ディレクトリを作る。cleanupLaunched で削除される
 * @param prefix ディレクトリ名の接頭辞
 * @returns 作ったディレクトリの絶対パス
 */
export async function makeTmpDir(prefix = 'rv-e2e-l-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * ディレクトリの下すべてに、所有者の読み書き実行の権限を戻す(権限を落としたテストの後始末用)
 * @param path 対象のパス
 * @returns なし
 */
export async function restorePermissions(path: string): Promise<void> {
  let st;
  try {
    st = await lstat(path);
  } catch (err) {
    // すでに無ければ戻す対象がない
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) return;
  await chmod(path, st.isDirectory() ? 0o700 : st.mode | 0o600);
  if (st.isDirectory()) {
    for (const name of await readdir(path)) await restorePermissions(join(path, name));
  }
}

/**
 * `npm start` を、標準入力を端末でなくして起動する
 *
 * @param opts 起動オプション
 * @returns 起動した試行
 */
export async function launchApp(opts: LaunchOptions = {}): Promise<Launched> {
  const port = opts.port ?? (await freePort());
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SPEC_ENV_NAMES) delete env[name];
  env.PORT = String(port);
  env.HOST = '127.0.0.1';
  for (const [name, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

  const npmArgs = opts.prefix ? ['--prefix', APP_DIR, 'start'] : ['start'];
  if (opts.args && opts.args.length > 0) npmArgs.push('--', ...opts.args);

  const child = spawnNpm(npmArgs, opts.cwd ?? APP_DIR, env);
  let out = '';
  child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  let exit: { code: number | null; signal: string | null } | null = null;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });

  const kill = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // すでに終了している場合は何もしない
    }
  };
  const waitExit = async (timeoutMs = EXIT_TIMEOUT_MS): Promise<typeof exit> => {
    await waitUntil(() => exit !== null, timeoutMs, 100);
    return exit;
  };
  const l: Launched = {
    port,
    output: () => out,
    waitExit,
    waitReady: (timeoutMs = 20_000) =>
      waitUntil(async () => {
        if (exit !== null) return true;
        try {
          return (await request({ port }, '/healthz', { timeoutMs: 1_000 })).status === 200;
        } catch {
          return false;
        }
      }, timeoutMs, 200).then(async (ok) => ok && exit === null),
    stop: async () => {
      if (child.pid !== undefined && exit === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // すでに終了している場合は何もしない
        }
      }
      return waitExit(10_000);
    },
    kill,
  };
  launched.push(l);
  return l;
}

/**
 * launchApp で起動したプロセスをすべて止め、makeTmpDir で作ったディレクトリを削除する(afterEach 用)
 * @returns なし
 */
export async function cleanupLaunched(): Promise<void> {
  for (const l of launched.splice(0)) l.kill();
  for (const d of tmpDirs.splice(0)) {
    await restorePermissions(d);
    await rm(d, { recursive: true, force: true });
  }
}

/**
 * 「待ち受けを始めずに、理由を示して、終了コード 0 以外で終了した」ことを検証する材料を集める
 *
 * @param l 起動した試行
 * @returns 終了の様子、出力、待ち受けているか
 */
export async function observeRefusal(l: Launched): Promise<{
  exit: { code: number | null; signal: string | null } | null;
  output: string;
  listening: boolean;
}> {
  const exit = await l.waitExit();
  return { exit, output: l.output(), listening: await canConnect('127.0.0.1', l.port, 500) };
}
