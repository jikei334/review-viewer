/**
 * 画面の入口(T1-0 時点の最小構成)
 *
 * 画面の実装(React)は T1-3 で入る。ここでは、ビルドが通ることを確認するための
 * 仮の表示だけを行う。
 */

/**
 * 仮の表示を、指定した要素に書き込む
 *
 * HTML としてではなく、テキストとして設定する(CLAUDE.md の絶対ルール7)。
 *
 * @param container 表示先の要素
 * @returns なし
 */
function renderPlaceholder(container: HTMLElement): void {
  container.textContent = 'Review Viewer: 画面はまだ実装されていません';
}

const root = document.getElementById('root');
if (root === null) {
  throw new Error('表示先の要素 #root が見つかりません');
}
renderPlaceholder(root);
