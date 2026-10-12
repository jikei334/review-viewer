/**
 * サーバーの入口(`npm start` が実行する。SPEC §2.5)
 *
 * 副作用(環境変数の読み込み、待ち受けの開始、シグナルの登録、プロセスの終了)は、
 * このファイルだけに置く。テストからは import しない。
 * アプリの組み立ては app.ts、検証は request-guard.ts、設定は config.ts、起動と停止は server.ts。
 */
import { loadConfig } from './config.js';
import { closeServer, createShutdownHandler, describeError, startServer } from './server.js';

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
 * サーバーを起動し、終了シグナルのハンドラを登録する
 *
 * @returns 待ち受けを始めたら解決する
 * @throws 設定が不正なとき、または待ち受けを始められなかったとき
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const server = await startServer(config);

  // コンテナ内の PID 1 では、SIGTERM / SIGINT の既定の動作が効かないので、明示的に登録する(C-6)
  const shutdown = createShutdownHandler({
    close: () => closeServer(server),
    log,
    exit: (code) => process.exit(code),
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // 起動ログには、待ち受け先だけを出す。環境変数を丸ごと出さない(C-5)
  log(`Review Viewer: http://${config.host}:${config.port} で待ち受けています`);
}

main().catch((err: unknown) => {
  log(`Review Viewer: 起動に失敗しました: ${describeError(err)}`);
  process.exit(1);
});
