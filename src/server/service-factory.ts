/**
 * ReviewService の組み立て(起動の入口 index.ts と dev.ts が共有する)
 *
 * RepoReader(読む入口)と ReviewStore(書く入口)を作り、保存ファイルを読み込んでから
 * ReviewService に渡す。保存ファイルが壊れていれば、ここで失敗する(待ち受けを始める前に気づけるように)。
 */
import type { ServerConfig } from './config.js';
import { RepoReader } from './RepoReader.js';
import { ReviewService } from './ReviewService.js';
import { ReviewStore } from './ReviewStore.js';

/** 組み立てた業務ロジックと、終了処理で待つためのストア */
export interface OpenedService {
  readonly service: ReviewService;
  readonly store: ReviewStore;
}

/**
 * ReviewService を、読み込み済みの ReviewStore つきで作る
 *
 * @param config 対象リポジトリと保存先
 * @param log ログの出力先(省略時は標準エラー)
 * @returns 業務ロジックとストア
 * @throws ReviewStoreError 保存先を調べられない、保存ファイルが壊れている、または読めないとき
 */
export async function openReviewService(
  config: Pick<ServerConfig, 'repoDir' | 'dataDir'>,
  log: (message: string) => void = (m) => process.stderr.write(`${m}\n`)
): Promise<OpenedService> {
  const store = new ReviewStore({ dataDir: config.dataDir });
  // 前回の異常終了で残った一時ファイルを、読み込みの前に掃除する。個別の削除失敗は起動を止めない
  // (害のない残骸で、次回また掃除される)が、黙らずにログに出す
  const cleanup = await store.cleanupTempFiles();
  if (cleanup.removed > 0) log(`Review Viewer: 前回の一時ファイルを ${cleanup.removed} 件消しました`);
  if (cleanup.failed > 0) log(`Review Viewer: 一時ファイルを ${cleanup.failed} 件消せませんでした`);
  await store.load();
  const service = new ReviewService({ repoReader: new RepoReader({ repoDir: config.repoDir }), store });
  return { service, store };
}
