/**
 * HTTP サーバーの起動と停止
 *
 * `process` には触れない(シグナルの登録と終了コードは、入口の index.ts が行う)。
 * テストから、空きポートで起動して、停止まで確かめられるようにする。
 */
import { createServer, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { createApp, type AppDeps } from './app.js';
import type { ServerConfig } from './config.js';

/** 停止のとき、処理中のリクエストの完了を待つ時間の既定値(ミリ秒) */
export const DEFAULT_SHUTDOWN_GRACE_MS = 3000;

/** ログの出力先(1行分の文字列を受け取る) */
export type Logger = (message: string) => void;

/** プロセスの終了(テストで差し替えられるようにする) */
export type ExitFn = (code: number) => void;

/**
 * サーバーを起動して、待ち受けを始めるまで待つ
 *
 * `@hono/node-server` の `hostname` オプション(Host ヘッダが無いときの代用値)は渡さない。
 * Host ヘッダの無いリクエストを、bind アドレスで補って通さないため。
 *
 * @param config サーバーの設定
 * @param deps アプリが使うもの(ログの出力先など。省略可)
 * @returns 待ち受け中の HTTP サーバー
 * @throws 待ち受けを始められなかったとき(ポートが使用中など)
 */
export function startServer(config: ServerConfig, deps: AppDeps = {}): Promise<Server> {
  const app = createApp(config, deps);
  const server = createServer(getRequestListener(app.fetch));

  return new Promise<Server>((resolveStart, rejectStart) => {
    /**
     * 待ち受けの開始に失敗したときの処理
     *
     * @param err listen のエラー
     * @returns なし
     */
    const onError = (err: Error): void => {
      rejectStart(err);
    };
    server.once('error', onError);
    server.listen(config.port, config.host, () => {
      server.off('error', onError);
      resolveStart(server);
    });
  });
}

/**
 * サーバーを停止する(C-6)
 *
 * 新しい接続の受け付けをやめ、使われていない keep-alive の接続はすぐに閉じる。
 * 処理中のリクエストは `graceMs` だけ待ち、それでも残っている接続は切断する
 * (接続が残っているせいで、いつまでも終了できない状態を避ける)。
 *
 * @param server 停止するサーバー
 * @param graceMs 処理中のリクエストの完了を待つ時間(ミリ秒)
 * @returns すべての接続が閉じたら解決する
 * @throws サーバーを閉じられなかったとき(すでに停止している場合など)
 */
export function closeServer(
  server: Server,
  graceMs: number = DEFAULT_SHUTDOWN_GRACE_MS
): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, graceMs);

    server.close((err) => {
      clearTimeout(timer);
      if (err) rejectClose(err);
      else resolveClose();
    });
    // 対象の Node.js では、close() が使われていない接続も閉じる。意図が分かるように明示しておく
    server.closeIdleConnections();
  });
}

/** シグナルを受けたときの処理に必要なもの */
export interface ShutdownDeps {
  /** サーバー(と、後のステージでは書き込み中のデータ)を閉じる処理 */
  readonly close: () => Promise<void>;
  /** ログの出力先 */
  readonly log: Logger;
  /** プロセスの終了 */
  readonly exit: ExitFn;
}

/**
 * 終了シグナルを受けたときの処理を作る(C-6)
 *
 * 2回目以降のシグナルは、進行中の停止を邪魔しないように無視する。
 * 正常に閉じられたら終了コード 0、失敗したら 1 で終了する。
 *
 * @param deps 閉じる処理、ログの出力先、プロセスの終了
 * @returns シグナルの名前を受け取るハンドラ
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => void {
  let shuttingDown = false;
  return (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log(`Review Viewer: ${signal} を受け取りました。終了します`);
    deps.close().then(
      () => {
        deps.exit(0);
      },
      (err: unknown) => {
        deps.log(`Review Viewer: 終了処理に失敗しました: ${describeError(err)}`);
        deps.exit(1);
      }
    );
  };
}

/** 終了シグナルを登録する相手(`process` と同じ形。テストで差し替えられるようにする) */
export interface SignalTarget {
  /**
   * シグナルのハンドラを登録する
   *
   * @param signal シグナルの名前
   * @param listener シグナルを受けたときに呼ばれる関数(シグナルの名前を受け取る)
   * @returns 何を返してもよい(`process.on` は自分自身を返す)
   */
  on(signal: ShutdownSignal, listener: (signal: string) => void): unknown;
}

/** 明示的にハンドラを登録する終了シグナル */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** 終了シグナルの名前 */
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/**
 * 終了シグナル(SIGTERM / SIGINT)のハンドラを登録する(C-6)
 *
 * コンテナ内の PID 1 では、シグナルの既定の動作が効かないので、明示的に登録する。
 * **待ち受けを始める前に呼ぶこと**(起動の途中で届いたシグナルを取りこぼさないため)。
 *
 * @param target 登録する相手(`process` を渡す)
 * @param handler シグナルの名前を受け取るハンドラ(`createShutdownHandler` の戻り値)
 * @returns なし
 */
export function registerShutdownSignals(target: SignalTarget, handler: (signal: string) => void): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    target.on(signal, handler);
  }
}

/**
 * エラーを、ログに出す1行の文字列にする
 *
 * @param err 捕まえた値
 * @returns `名前: メッセージ` の形の文字列
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
