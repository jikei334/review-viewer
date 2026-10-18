/**
 * 画面の「いま開いているレポート」と URL の対応
 *
 * URL のハッシュ(`#/report/<パスを URL エンコードしたもの>`)に持つ。サーバーに別の経路を
 * 要求せず、リンクの `href` だけで切り替えられ、ブラウザの「戻る」も効く。
 */

/** ハッシュの先頭の固定部分 */
const REPORT_HASH_PREFIX = '#/report/';

/**
 * レポートのパスから、リンク先のハッシュを作る
 *
 * @param path リポジトリ相対パス
 * @returns `#/report/...` の形の文字列
 */
export function reportHash(path: string): string {
  return `${REPORT_HASH_PREFIX}${encodeURIComponent(path)}`;
}

/**
 * ハッシュから、開くレポートのパスを取り出す
 *
 * 形が合わない、またはデコードできないハッシュは、レポートを開かない(null)。
 * 取り出したパスの検証はサーバー(RepoReader)が行う。
 *
 * @param hash `location.hash` の値
 * @returns リポジトリ相対パス。開くレポートが無ければ null
 */
export function parseReportHash(hash: string): string | null {
  if (!hash.startsWith(REPORT_HASH_PREFIX)) return null;
  try {
    const path = decodeURIComponent(hash.slice(REPORT_HASH_PREFIX.length));
    return path === '' ? null : path;
  } catch {
    // 不正なエスケープ(%E3 だけ、など)。開かないだけで、画面は壊さない
    return null;
  }
}
