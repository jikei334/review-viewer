/**
 * ソースツリーの展開状態の純粋関数
 */

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
