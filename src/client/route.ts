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

/** 画面の状態(開いているレポートと、右ペインのソース) */
export interface ViewRoute {
  /** 開くレポートのパス。無ければ null */
  readonly report: string | null;
  /** 右ペインに開くソース。無ければ null */
  readonly source: { readonly path: string; readonly line: number | null } | null;
}

/**
 * 行番号の文字列を、1 以上の整数として読む
 *
 * @param value 文字列(null 可)
 * @returns 行番号。読めない、または 1 未満なら null
 */
function parseLine(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,9}$/.test(value)) return null;
  const line = Number(value);
  return line >= 1 ? line : null;
}

/**
 * ハッシュ全体から、画面の状態を取り出す
 *
 * 形は `#/report/<パス>` に、続けて任意で `?src=<パス>&line=<行>` を付ける(レポート無しの
 * ときは `#/?src=...`)。値は URL エンコードされているので、`?` での分割は安全。
 *
 * @param hash `location.hash` の値
 * @returns 画面の状態(読めない部分は null)
 */
export function parseRoute(hash: string): ViewRoute {
  const queryIndex = hash.indexOf('?');
  const base = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : hash.slice(queryIndex + 1));
  const src = params.get('src');
  return {
    report: parseReportHash(base),
    source: src === null || src === '' ? null : { path: src, line: parseLine(params.get('line')) },
  };
}

/**
 * 画面の状態から、ハッシュを作る(parseRoute の逆)
 *
 * @param route 画面の状態
 * @returns `#` で始まる文字列
 */
export function buildRoute(route: ViewRoute): string {
  const base = route.report === null ? '#/' : reportHash(route.report);
  if (route.source === null) return base;
  const params = new URLSearchParams({ src: route.source.path });
  if (route.source.line !== null) params.set('line', String(route.source.line));
  return `${base}?${params.toString()}`;
}
