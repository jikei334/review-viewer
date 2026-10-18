/**
 * e2e テスト用サーバー起動・停止ヘルパー
 *
 * SPEC §2.5 の起動インターフェース(npm start / 環境変数 / GET /healthz / SIGTERM)
 * だけを使う。src/ の実装には依存しない。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canConnect, request, waitUntil } from './http.js';

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * アプリのルート(`npm start` を実行する場所)。既定は e2e/ の1階層上。
 * 環境変数 `E2E_APP_DIR` は、ハーネス自体の自己点検(ダミーのアプリに向ける)用。
 */
export const APP_DIR = process.env.E2E_APP_DIR
  ? resolve(process.env.E2E_APP_DIR)
  : resolve(HELPERS_DIR, '../../');

/** コミット済みフィクスチャのリポジトリ */
export const FIXTURES_REPO = resolve(HELPERS_DIR, '../fixtures/repo');

/** SPEC §2.5 で定義された環境変数。テスト実行者の環境から漏れ込まないように、いったん除去する */
const SPEC_ENV_NAMES = [
  'REPO_DIR',
  'DATA_DIR',
  'HOST',
  'PORT',
  'REVIEW_VIEWER_TOKEN',
  'ALLOWED_HOSTS',
  'ALLOWED_ORIGINS',
] as const;

/** 既定値の検証のために、あえて渡さないことを選べる環境変数 */
export type OmittableEnv = 'HOST' | 'ALLOWED_HOSTS' | 'ALLOWED_ORIGINS';

/** サーバーへ送るシグナル */
export type StopSignal = 'SIGTERM' | 'SIGINT';

/** 停止の結果 */
export interface StopResult {
  /** 時間内に終了せず、SIGKILL で強制終了したら true */
  forced: boolean;
  /** シグナルを送ってから、プロセスが終了しポートが閉じるまでの時間(ミリ秒) */
  elapsedMs: number;
  /** プロセスの終了コード(シグナルで終了した、または強制終了したときは null) */
  exitCode: number | null;
}

/** 起動済みのテスト用サーバー */
export interface TestServer {
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  /** サーバーのポート番号 */
  port: number;
  /** 一時的な REPO_DIR のパス */
  repoDir: string;
  /** 一時的な DATA_DIR のパス */
  dataDir: string;
  /**
   * これまでにサーバーが標準出力・標準エラーへ出した内容を返す
   * @returns 標準出力と標準エラーを連結した文字列
   */
  logs: () => string;
  /**
   * サーバーを停止して、一時ディレクトリを削除する(2回目以降の呼び出しは最初の結果を返す)
   * @param signal 送るシグナル。既定は SIGTERM
   * @param serverOnly true なら、サーバー本体(`npm start` が起動した node プロセス)だけにシグナルを送る。
   *   npm はサーバーの終了コードで終了するので、`exitCode` からサーバーの終了コードが分かる(Linux のみ)。
   *   false(既定)なら、プロセスグループ全体に送る(端末で Ctrl+C を押したときの形)。
   *   グループ全体に送ると npm 自身もシグナルで終了するため、サーバー本体の終了コードは観測できない
   * @returns 強制終了したかどうかと、終了までの時間
   */
  stop: (signal?: StopSignal, serverOnly?: boolean) => Promise<StopResult>;
}

/** 起動オプション */
export interface StartOptions {
  /** MCP トークン。省略時は REVIEW_VIEWER_TOKEN を設定しない */
  token?: string;
  /**
   * 許可する Host ヘッダ(カンマ区切り)。省略時は `127.0.0.1:<port>,localhost:<port>`。
   * `allowedHosts`、`allowedOrigins`、`healthHost` の中の `{port}` は、実際のポート番号に置き換わる
   */
  allowedHosts?: string;
  /** 許可する Origin(カンマ区切り)。省略時は `http://127.0.0.1:<port>,http://localhost:<port>` */
  allowedOrigins?: string;
  /** ここに挙げた環境変数は渡さない(SPEC §2.5 の既定値を検証するため) */
  omitEnv?: OmittableEnv[];
  /** 起動確認(GET /healthz)で送る Host ヘッダ。省略時は `127.0.0.1:<port>` */
  healthHost?: string;
  /**
   * サーバー起動前に repoDir / dataDir を変更できるコールバック。
   * 大きなファイル、シンボリックリンク、秘密ファイルに見えるダミーなどを動的に作るために使う。
   * @param repoDir 一時的な REPO_DIR
   * @param dataDir 一時的な DATA_DIR
   * @param port サーバーが使うポート番号
   */
  setup?: (repoDir: string, dataDir: string, port: number) => Promise<void>;
  /** 起動完了を待つ上限(ミリ秒)。既定は 20 秒 */
  startTimeoutMs?: number;
}

/** 異常終了時の後始末のために、起動中のプロセスを覚えておく */
const runningProcesses = new Set<ChildProcess>();

process.on('exit', () => {
  // テストランナーが途中で終わっても、サーバーのプロセスを残さない
  for (const proc of runningProcesses) {
    signalGroup(proc, 'SIGKILL');
  }
});

/**
 * 空きポートを1つ取得する
 * @returns 利用可能な TCP ポート番号
 */
async function getFreePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
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
 * 子プロセスのプロセスグループ全体にシグナルを送る
 *
 * `npm start` は npm → シェル → サーバー本体、と複数のプロセスになる。
 * npm だけにシグナルを送ると、サーバー本体に届くかどうかが npm の版に左右されるため、
 * グループ全体に送る(端末で Ctrl+C を押したときと同じ届き方)。
 *
 * @param proc `detached: true` で起動した子プロセス
 * @param signal 送るシグナル
 * @returns シグナルを送れたら true。すでにプロセスが存在しなければ false
 */
function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): boolean {
  if (proc.pid === undefined) return false;
  try {
    process.kill(-proc.pid, signal);
    return true;
  } catch (err) {
    // すでに終了済み(ESRCH)なら、送る相手がいないだけなので false を返す
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

/**
 * `npm start` のプロセスグループの中から、サーバー本体(node プロセス。npm 自身を除く)を探す(Linux のみ)
 *
 * @param leaderPid `npm start` のプロセス ID(プロセスグループ ID でもある)
 * @returns サーバー本体と思われるプロセス ID の一覧
 */
async function findServerPids(leaderPid: number): Promise<number[]> {
  const found: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === leaderPid) continue;
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // "pid (comm) state ppid pgrp ..." comm は括弧を含みうるので、最後の ')' の後ろを見る
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      const pgrp = Number(rest[2]);
      if (pgrp === leaderPid && comm === 'node') found.push(pid);
    } catch {
      // 調べている間に終了したプロセスは無視してよい
    }
  }
  return found;
}

/**
 * レポートのフィクスチャの更新日時を、ファイル名の日付(YYYY-MM-DD-*.md)に揃える
 *
 * SPEC S1-1 の「新しい順」が、更新日時とファイル名の日付のどちらを指しても
 * 同じ並びになるようにするため(SPEC の曖昧点。Tester 報告を参照)。
 *
 * @param repoDir 一時的な REPO_DIR
 * @returns なし(更新日時を書き換えるだけ)
 */
async function alignReportMtimes(repoDir: string): Promise<void> {
  const reportsDir = join(repoDir, 'reports');
  const names = await readdir(reportsDir);
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})-/.exec(name);
    if (!m) continue;
    const date = new Date(`${m[1]}T00:00:00Z`);
    await utimes(join(reportsDir, name), date, date);
  }
}

/**
 * テスト用サーバーを起動する
 *
 * - fixtures/repo を一時ディレクトリにコピーして REPO_DIR とする
 * - ランダムなポートで `npm start` を実行し、GET /healthz が 200 になるまで待つ
 * - 返した TestServer の stop() を afterAll などで必ず呼ぶこと
 *
 * @param options 起動オプション
 * @returns 起動済みサーバーのハンドル
 */
export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const port = await getFreePort();
  const tmpBase = await mkdtemp(join(tmpdir(), 'rv-e2e-'));
  const repoDir = join(tmpBase, 'repo');
  const dataDir = join(tmpBase, 'data');
  const omit = new Set<string>(options.omitEnv ?? []);

  let proc: ChildProcess | undefined;
  let output = '';

  /**
   * 文字列の中の `{port}` を、実際のポート番号に置き換える
   * @param value 置き換え前の文字列
   * @returns 置き換え後の文字列
   */
  const withPort = (value: string): string => value.replaceAll('{port}', String(port));

  try {
    await cp(FIXTURES_REPO, repoDir, { recursive: true, verbatimSymlinks: true });
    await alignReportMtimes(repoDir);
    await mkdir(dataDir, { recursive: true });
    if (options.setup) {
      await options.setup(repoDir, dataDir, port);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of SPEC_ENV_NAMES) delete env[name];
    env.REPO_DIR = repoDir;
    env.DATA_DIR = dataDir;
    env.PORT = String(port);
    if (!omit.has('HOST')) env.HOST = '127.0.0.1';
    if (!omit.has('ALLOWED_HOSTS')) {
      env.ALLOWED_HOSTS = withPort(options.allowedHosts ?? '127.0.0.1:{port},localhost:{port}');
    }
    if (!omit.has('ALLOWED_ORIGINS')) {
      env.ALLOWED_ORIGINS = withPort(
        options.allowedOrigins ?? 'http://127.0.0.1:{port},http://localhost:{port}'
      );
    }
    if (options.token !== undefined) env.REVIEW_VIEWER_TOKEN = options.token;

    const child = spawn('npm', ['start'], {
      cwd: APP_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // プロセスグループを分けて、グループ単位でシグナルを送れるようにする。
      // 注意: detached にすると、テストランナー自体が SIGKILL されたとき(exit ハンドラが動かないとき)は、
      // サーバーのプロセスが孤児として残る。その場合は手動で終了させること
      detached: true,
    });
    proc = child;
    runningProcesses.add(child);

    // 出力を読み続ける(読まないとパイプが詰まってサーバーが止まる)。C-5 の検証にも使う
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    let spawnError: Error | undefined;
    let exited = false;
    child.once('error', (err) => {
      spawnError = err;
    });
    child.once('exit', () => {
      exited = true;
    });

    const healthHost = withPort(options.healthHost ?? '127.0.0.1:{port}');
    const timeoutMs = options.startTimeoutMs ?? 20_000;
    let lastProblem = '(まだ一度も応答がありません)';
    const ready = await waitUntil(async () => {
      if (spawnError || exited) return true;
      try {
        const res = await request({ port }, '/healthz', {
          headers: { Host: healthHost },
          timeoutMs: 1_000,
        });
        if (res.status === 200) return true;
        lastProblem = `GET /healthz が ${res.status} を返しました`;
      } catch (err) {
        // 起動途中は接続できないのが普通。最後の状況として記録し、待ち続ける
        lastProblem = String(err);
      }
      return false;
    }, timeoutMs, 200);

    if (spawnError) {
      throw new Error(`npm start を実行できませんでした: ${String(spawnError)}`);
    }
    if (exited) {
      throw new Error(
        `npm start が起動完了の前に終了しました(${APP_DIR})。出力:\n${output}`
      );
    }
    if (!ready) {
      throw new Error(
        `${timeoutMs}ms 以内に GET /healthz が 200 になりませんでした。` +
          `最後の状況: ${lastProblem}\n出力:\n${output}`
      );
    }
  } catch (err) {
    if (proc) {
      signalGroup(proc, 'SIGKILL');
      runningProcesses.delete(proc);
    }
    await rm(tmpBase, { recursive: true, force: true });
    throw err;
  }

  const child = proc;
  let stopPromise: Promise<StopResult> | undefined;

  /**
   * サーバーを停止する本体(1回だけ実行される)
   * @param signal 送るシグナル
   * @returns 停止の結果
   */
  const doStop = async (signal: StopSignal, serverOnly: boolean): Promise<StopResult> => {
    const startedAt = Date.now();
    const exitedPromise = new Promise<void>((r) => {
      if (child.exitCode !== null || child.signalCode !== null) r();
      else child.once('exit', () => r());
    });
    let hasExited = false;
    void exitedPromise.then(() => {
      hasExited = true;
    });

    if (serverOnly && child.pid !== undefined) {
      const targets = await findServerPids(child.pid);
      if (targets.length === 0) {
        throw new Error('サーバー本体のプロセスが見つかりません(/proc を調べました)');
      }
      for (const pid of targets) {
        try {
          process.kill(pid, signal);
        } catch (err) {
          // すでに終了済み(ESRCH)なら送る相手がいないだけ
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        }
      }
    } else {
      signalGroup(child, signal);
    }

    // 正常終了 = npm のプロセスが終わり、かつポートが閉じること
    const graceful = await waitUntil(
      async () => hasExited && !(await canConnect('127.0.0.1', port, 500)),
      5_000,
      50
    );
    const elapsedMs = Date.now() - startedAt;

    if (!graceful) {
      signalGroup(child, 'SIGKILL');
      await waitUntil(
        async () => hasExited && !(await canConnect('127.0.0.1', port, 500)),
        5_000,
        50
      );
    }
    const exitCode = child.exitCode;
    runningProcesses.delete(child);
    await rm(tmpBase, { recursive: true, force: true });
    return { forced: !graceful, elapsedMs, exitCode };
  };

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    repoDir,
    dataDir,
    logs: () => output,
    stop: (signal: StopSignal = 'SIGTERM', serverOnly = false) => {
      stopPromise ??= doStop(signal, serverOnly);
      return stopPromise;
    },
  };
}

/**
 * サーバーが起動済みなら停止する(afterAll 用)
 *
 * beforeAll が失敗するとサーバーのハンドルは未定義のままになる。
 * そのまま `server.stop()` を呼ぶと TypeError になり、本来の失敗の原因が隠れるので、これを使う。
 *
 * @param server 起動済みサーバーのハンドル。起動に失敗していれば undefined
 * @returns なし
 */
export async function stopIfStarted(server: TestServer | undefined): Promise<void> {
  if (server === undefined) return;
  await server.stop();
}
