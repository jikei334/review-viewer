/**
 * サーバーの入口(`npm start` が実行する。SPEC §2.5)
 *
 * 副作用(環境変数の読み込み、待ち受けの開始、シグナルの登録、プロセスの終了)は、
 * このファイルだけに置く。テストからは import しない。
 * アプリの組み立ては app.ts、検証は request-guard.ts、設定は config.ts、起動と停止は server.ts。
 */
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { RepoDirCancelledError } from './repo-dir.js';
import { resolveRepoDirFromProcess } from './repo-dir-io.js';
import {
  closeServer,
  createShutdownHandler,
  describeError,
  registerShutdownSignals,
  startServer,
} from './server.js';
import { StaticAssets } from './static-assets.js';

/** 画面のビルド成果物のディレクトリ(dist/server/index.js から見た dist/client) */
const CLIENT_DIR = fileURLToPath(new URL('../client', import.meta.url));

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
 * 終了シグナルのハンドラを登録してから、サーバーを起動する
 *
 * @returns 待ち受けを始めたら解決する
 * @throws 設定が不正なとき、または待ち受けを始められなかったとき
 */
async function main(): Promise<void> {
  const baseConfig = loadConfig(process.env);
  // 起動したサーバーの入れ物(待ち受けを始めるまでは空)
  const running: { server?: Server } = {};

  // 待ち受けを始める前に登録する。起動の途中でシグナルが届いたら、閉じるものが
  // まだ無いので、そのまま終了する(C-6)
  const shutdown = createShutdownHandler({
    close: () => (running.server === undefined ? Promise.resolve() : closeServer(running.server)),
    log,
    exit: (code) => process.exit(code),
  });
  registerShutdownSignals(process, shutdown);

  // 対象リポジトリは、待ち受けを始める前に決めて検証する(SPEC §2.5、S1-10)。
  // 入力の待機中に届いたシグナルも、上で登録したハンドラが正常終了させる
  let repoDir: string;
  try {
    repoDir = await resolveRepoDirFromProcess();
  } catch (err: unknown) {
    if (err instanceof RepoDirCancelledError) {
      log(`Review Viewer: ${err.message}。終了します`);
      process.exit(0);
    }
    throw err;
  }
  const config = { ...baseConfig, repoDir };

  // 画面のビルド成果物が無ければ、ここで失敗させる(画面が空のまま動いていると気づけないため)
  const assets = await StaticAssets.load(CLIENT_DIR);
  running.server = await startServer(config, { log, assets });

  // 起動ログには、待ち受け先だけを出す。環境変数を丸ごと出さない(C-5)
  log(`Review Viewer: http://${config.host}:${config.port} で待ち受けています`);
}

main().catch((err: unknown) => {
  log(`Review Viewer: 起動に失敗しました: ${describeError(err)}`);
  process.exit(1);
});
