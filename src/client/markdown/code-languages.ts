/**
 * Markdown の中のコードブロック(フェンス)の言語の抽出
 *
 * シンタックスハイライトの文法は非同期で読み込むので、描画の前に、必要な言語を知る必要がある。
 */
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/** 構文木のノード(必要な部分だけの形) */
interface MarkdownNode {
  readonly type: string;
  readonly lang?: string | null;
  readonly children?: readonly MarkdownNode[];
}

/** Mermaid のブロックの言語名(ハイライトの対象ではなく、図として描画する) */
export const MERMAID_LANGUAGE = 'mermaid';

/**
 * 構文木をたどって、コードブロックの言語を集める
 *
 * @param node たどる起点のノード
 * @param found 見つけた言語の入れ物(小文字)
 * @returns なし(found に追加する)
 */
function collectLanguages(node: MarkdownNode, found: Set<string>): void {
  if (node.type === 'code' && typeof node.lang === 'string' && node.lang !== '') {
    found.add(node.lang.toLowerCase());
  }
  for (const child of node.children ?? []) {
    collectLanguages(child, found);
  }
}

/**
 * Markdown の中のコードブロックの言語を、重複なしで列挙する
 *
 * `mermaid` は、図として描画するので除く。言語名は小文字にそろえる。
 *
 * @param markdown Markdown の本文
 * @returns 言語名の一覧(出現順)
 */
export function extractCodeLanguages(markdown: string): string[] {
  const tree = unified().use(remarkParse).parse(markdown) as MarkdownNode;
  const found = new Set<string>();
  collectLanguages(tree, found);
  found.delete(MERMAID_LANGUAGE);
  return [...found];
}
