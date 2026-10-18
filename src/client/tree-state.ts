/**
 * ソースツリーの展開状態と、ディレクトリ1つ分の取得
 */
import { fetchTree, type TreeEntry } from './api.js';

/** ディレクトリ1つ分の取得状態 */
export type Listing =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly entries: readonly TreeEntry[] };

/**
 * ディレクトリの中身を取得して、取得状態にする(失敗しても例外にせず、error にする)
 *
 * @param path ディレクトリのパス(ルートは空文字列)
 * @returns ready(一覧つき)または error
 */
export async function loadListing(path: string): Promise<Listing> {
  try {
    return { status: 'ready', entries: await fetchTree(path) };
  } catch (err) {
    console.error('Review Viewer: ディレクトリ一覧を取得できませんでした', err);
    return { status: 'error' };
  }
}

/**
 * ディレクトリを開くときに、中身を取得する必要があるかを返す
 *
 * 未取得、または前回失敗したときだけ取得する。取得中・取得済みなら取得しない。
 *
 * @param listing そのディレクトリの取得状態(未取得なら undefined)
 * @returns 取得が必要なら true
 */
export function needsLoad(listing: Listing | undefined): boolean {
  return listing === undefined || listing.status === 'error';
}

/**
 * ディレクトリの開閉を切り替えた、新しい展開状態を返す(元の集合は変更しない)
 *
 * @param expanded 展開しているディレクトリのパスの集合
 * @param path 切り替えるディレクトリのパス
 * @returns 新しい集合(開いていれば閉じ、閉じていれば開く)
 */
export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
