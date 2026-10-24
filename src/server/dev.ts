/**
 * 開発サーバーの入口(`npm run dev` が実行する)
 *
 * 画面(Vite の開発サーバー)と API(Hono のアプリ)を、1つのプロセス・1つのポートで動かす。
 * Vite の開発サーバーに、`/api` と `/healthz` だけを Hono のアプリへ渡すミドルウェアを足す。
 * リクエストは同じプロセス内で渡されるので、Host / Origin の検証(request-guard)はそのまま働く
 * (中継で Host を書き換える必要がなく、許可リストを広げない)。
 *
 * 本番用の入口(index.ts)と同じく、対象リポジトリの決め方(SPEC §2.5)に従う。
 * 副作用(待ち受け、シグナルの登録、プロセスの終了)はこのファイルだけに置く。
 * サーバー側のコードを変えたときは、`npm run dev` を起動し直す(ビルドし直してから起動する)。
 */
import { getRequestListener } from '@hono/node-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer, type Plugin } from 'vite';
import { createApp } from './app.js';
import type { ReviewStore } from './ReviewStore.js';
import { loadConfig } from './config.js';
import { isApiPath } from './dev-routes.js';
import { resolveDataDirFromProcess } from './data-dir-io.js';
import { parseLaunchArgs } from './launch-args.js';
import { RepoDirCancelledError } from './repo-dir.js';
import { resolveRepoDirFromProcess } from './repo-dir-io.js';
import { openReviewService } from './service-factory.js';
import { describeError } from './server.js';

/** 開発サーバーの既定のポート(SPEC の PORT の既定 3000 は本番用。開発では Vite の慣例に合わせる) */
const DEV_DEFAULT_PORT = '5173'; // 暫定: SPEC に開発サーバーのポートの定めがないため

/** Vite の設定ファイル(dist/server/dev.js から見たリポジトリのルートの vite.config.ts) */
const VITE_CONFIG_FILE = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));

/**
 * ログを1行、標準エラーへ出す
 *
 * @param message 出力する文字列
 * @returns なし
 */
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Vite の開発サーバーに API を載せるプラグインを作る
 *
 * @param fetchHandler Hono アプリのリクエストリスナー
 * @returns Vite のプラグイン
 */
function apiPlugin(
  fetchHandler: (req: IncomingMessage, res: ServerResponse) => unknown
): Plugin {
  return {
    name: 'review-viewer-api',
    configureServer(server) {
      // Vite 自身のミドルウェアより前に登録して、API のパスだけを横取りする
      server.middlewares.use((req, res, next) => {
        if (isApiPath(req.url)) {
          Promise.resolve(fetchHandler(req, res)).catch((err: unknown) => {
            log(`Review Viewer: API の処理に失敗しました: ${describeError(err)}`);
            if (!res.headersSent) res.statusCode = 500;
            res.end();
          });
          return;
        }
        next();
      });
    },
  };
}

/**
 * 開発サーバーを起動する
 *
 * @returns 待ち受けを始めたら解決する
 * @throws 設定が不正なとき、対象リポジトリが決まらないとき、待ち受けを始められなかったとき
 */
async function main(): Promise<void> {
  // PORT 未設定なら開発用の既定。許可リストの既定値も、このポートに追従する
  const base = loadConfig({ ...process.env, PORT: process.env['PORT'] || DEV_DEFAULT_PORT });
  const launchArgs = parseLaunchArgs(process.argv.slice(2));
  const server: { vite?: Awaited<ReturnType<typeof createServer>>; store?: ReviewStore } = {};

  const stop = (signal: string): void => {
    log(`Review Viewer: ${signal} を受け取りました。終了します`);
    const closing = (async (): Promise<void> => {
      if (server.vite !== undefined) await server.vite.close();
      // 受け付け済みの書き込みの完了を待つ
      if (server.store !== undefined) await server.store.drain();
    })();
    closing.then(
      () => process.exit(0),
      (err: unknown) => {
        log(`Review Viewer: 終了処理に失敗しました: ${describeError(err)}`);
        process.exit(1);
      }
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let repoDir: string;
  try {
    repoDir = await resolveRepoDirFromProcess(launchArgs.positional);
  } catch (err: unknown) {
    if (err instanceof RepoDirCancelledError) {
      log(`Review Viewer: ${err.message}。終了します`);
      process.exit(0);
    }
    throw err;
  }
  // 本番と同じ保存先の決め方に従う(`./data` の特別扱いはしない)
  const dataDir = resolveDataDirFromProcess(repoDir, launchArgs.dataDir);
  const config = { ...base, repoDir, dataDir: dataDir.dir };
  if (dataDir.temporary) {
    log(`Review Viewer: 保存先は一時的な保存先(OS の再起動などで消えることがある)です: ${dataDir.dir}`);
  } else {
    log(`Review Viewer: 保存先: ${dataDir.dir}`);
  }
  const { service, store } = await openReviewService(config);
  server.store = store;
  const app = createApp(config, { log, service });

  server.vite = await createServer({
    configFile: VITE_CONFIG_FILE,
    plugins: [apiPlugin(getRequestListener(app.fetch))],
    // 開発でも config.host(既定 127.0.0.1)だけに bind する。ポートが使用中なら別のポートへ
    // 逃げず失敗させる(許可リストがポートに紐づくため)
    server: { host: config.host, port: config.port, strictPort: true },
  });
  await server.vite.listen();
  log(`Review Viewer(開発): http://${config.host}:${config.port} で待ち受けています`);
}

main().catch((err: unknown) => {
  log(`Review Viewer: 起動に失敗しました: ${describeError(err)}`);
  process.exit(1);
});
