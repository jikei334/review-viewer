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
import { resolveDataDirFromProcess } from './data-dir-io.js';
import { parseLaunchArgs } from './launch-args.js';
import { RepoDirCancelledError } from './repo-dir.js';
import { resolveRepoDirFromProcess } from './repo-dir-io.js';
import { openReviewService } from './service-factory.js';
import {
  closeServer,
  createShutdownHandler,
  describeError,
  registerShutdownSignals,
  startServer,
} from './server.js';
import type { ReviewStore } from './ReviewStore.js';
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
  // 引数の誤り(未知のオプション、--data-dir の値の欠落など)は、何も始める前に失敗させる
  const launchArgs = parseLaunchArgs(process.argv.slice(2));
  // 起動したサーバーの入れ物(待ち受けを始めるまでは空)
  const running: { server?: Server; store?: ReviewStore } = {};

  // 待ち受けを始める前に登録する。起動の途中でシグナルが届いたら、閉じるものが
  // まだ無いので、そのまま終了する(C-6)
  const shutdown = createShutdownHandler({
    // サーバーを閉じて(処理中のリクエストの完了を待って)から、受け付け済みの書き込みの完了を待つ。
    // 終了処理中の新しい書き込みを断る処理と、起動時の一時ファイルの掃除は、B3 で足す
    close: async () => {
      if (running.server !== undefined) await closeServer(running.server);
      if (running.store !== undefined) await running.store.drain();
    },
    log,
    exit: (code) => process.exit(code),
  });
  registerShutdownSignals(process, shutdown);

  // 対象リポジトリは、待ち受けを始める前に決めて検証する(SPEC §2.5、S1-10)。
  // 入力の待機中に届いたシグナルも、上で登録したハンドラが正常終了させる
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

  // 保存先は、対象リポジトリを決めた後、待ち受けを始める前に決めて検証する(SPEC §2.5、S2-9)。
  // 使えなければ DataDirError で失敗し、次の候補へは進まない
  const dataDir = resolveDataDirFromProcess(repoDir, launchArgs.dataDir);
  const config = { ...baseConfig, repoDir, dataDir: dataDir.dir };
  if (dataDir.temporary) {
    log(`Review Viewer: 保存先は一時的な保存先(OS の再起動などで消えることがある)です: ${dataDir.dir}`);
    log('Review Viewer: コメントを残すには --data-dir <パス> か環境変数 DATA_DIR で保存先を指定してください');
  } else {
    log(`Review Viewer: 保存先: ${dataDir.dir}`);
  }

  // 画面のビルド成果物が無ければ、ここで失敗させる(画面が空のまま動いていると気づけないため)
  const assets = await StaticAssets.load(CLIENT_DIR);
  // 保存ファイルの読み込み(壊れていればここで失敗する。黙って空にしない)
  const { service, store } = await openReviewService(config);
  running.store = store;
  running.server = await startServer(config, { log, assets, service });

  // 起動ログには、待ち受け先だけを出す。環境変数を丸ごと出さない(C-5)
  log(`Review Viewer: http://${config.host}:${config.port} で待ち受けています`);
}

main().catch((err: unknown) => {
  log(`Review Viewer: 起動に失敗しました: ${describeError(err)}`);
  process.exit(1);
});
