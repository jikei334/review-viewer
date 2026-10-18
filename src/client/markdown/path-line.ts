/**
 * Markdown 中の `path:line` 形式の参照(例: `src/server/index.ts:15`)をリンクにする(S1-8)
 *
 * - 文字列から参照を見つける部分(findPathLines)は、副作用のない純粋関数
 * - remark のプラグイン(remarkPathLine)は、mdast の text と inlineCode を書き換える
 * - リンクの `href` は、必ず buildRoute で作る(文書由来の値をそのまま URL に入れない)
 */
import { buildRoute } from '../route.js';

/** 見つけた参照 */
export interface PathLineMatch {
  /** 参照の開始位置(文字列の添字) */
  readonly start: number;
  /** 参照の終了位置(この位置は含まない) */
  readonly end: number;
  /** パス部分 */
  readonly path: string;
  /** 行番号(1 以上) */
  readonly line: number;
}

/**
 * 参照の形: `パス:行番号`
 *
 * - パスは ASCII の英数字と `_ . / @ + -` だけ。日本語などの隣接する文章を巻き込まない
 * - パスの先頭は `/` でなく、末尾は `.` や `/` でない(文末の句読点を含めない)
 * - 直前が、パスに使える文字や `:` なら始めない(`https://host/a.ts:3` や `a/b:3` の途中を拾わない)
 * - 最後の区間に `.` を含むか、`/` を含むもの(`12:30` や `localhost:8080` は参照ではない)
 * - 行番号の直後に英数字や `_` が続くものは参照ではない
 */
const PATH_LINE = /(?<![A-Za-z0-9_./@+:-])([A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]*[A-Za-z0-9_-]|[A-Za-z0-9_])(?::([0-9]{1,9}))(?![A-Za-z0-9_])/g;

/**
 * パスが、ファイルらしい形かを調べる(`/` か、拡張子の `.` を含む)
 *
 * @param path パス部分
 * @returns ファイルらしければ true
 */
function looksLikeFilePath(path: string): boolean {
  return path.includes('/') || /[A-Za-z0-9_-]\.[A-Za-z0-9_-]/.test(path);
}

/**
 * 文字列の中の `path:line` を、すべて見つける
 *
 * 行番号が 0 のものは見つけない(0 行目は無効)。
 *
 * @param text 調べる文字列
 * @returns 見つけた参照(出現順)
 */
export function findPathLines(text: string): PathLineMatch[] {
  const found: PathLineMatch[] = [];
  for (const m of text.matchAll(PATH_LINE)) {
    const path = m[1];
    const lineText = m[2];
    if (path === undefined || lineText === undefined) continue;
    const line = Number(lineText);
    if (line < 1 || !looksLikeFilePath(path)) continue;
    found.push({ start: m.index, end: m.index + m[0].length, path, line });
  }
  return found;
}

/** mdast のノードのうち、このプラグインが読み書きする最小の形 */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** 中を書き換えないノード(既存のリンク、コードブロック、定義など) */
const SKIPPED_TYPES: ReadonlySet<string> = new Set(['link', 'linkReference', 'code', 'definition', 'html', 'image']);

/**
 * 参照のリンク先(画面のハッシュ)を作る
 *
 * @param report いま開いているレポートのパス(無ければ null)
 * @param path ソースのパス
 * @param line 行番号
 * @returns `#/...` の形のリンク先
 */
function hrefFor(report: string | null, path: string, line: number): string {
  return buildRoute({ report, source: { path, line } });
}

/**
 * 子ノードの並びを、参照をリンクにして作り直す
 *
 * @param children 元の子ノード
 * @param report いま開いているレポートのパス
 * @returns 新しい子ノードの並び
 */
function transformChildren(children: MdNode[], report: string | null): MdNode[] {
  const result: MdNode[] = [];
  for (const child of children) {
    if (SKIPPED_TYPES.has(child.type)) {
      result.push(child);
    } else if (child.type === 'text' && typeof child.value === 'string') {
      result.push(...splitText(child.value, report));
    } else if (child.type === 'inlineCode' && typeof child.value === 'string') {
      // 暫定: インラインコードは、中身が全体で1つの参照のときだけリンクにする(`src/a.ts:3`)
      const matches = findPathLines(child.value);
      const only = matches[0];
      if (matches.length === 1 && only !== undefined && only.start === 0 && only.end === child.value.length) {
        result.push({ type: 'link', url: hrefFor(report, only.path, only.line), children: [child] });
      } else {
        result.push(child);
      }
    } else {
      if (child.children !== undefined) child.children = transformChildren(child.children, report);
      result.push(child);
    }
  }
  return result;
}

/**
 * 文字列を、text とリンクの並びに分ける
 *
 * @param value 元の文字列
 * @param report いま開いているレポートのパス
 * @returns ノードの並び(参照が無ければ元の text 1つ)
 */
function splitText(value: string, report: string | null): MdNode[] {
  const matches = findPathLines(value);
  if (matches.length === 0) return [{ type: 'text', value }];
  const nodes: MdNode[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) nodes.push({ type: 'text', value: value.slice(cursor, m.start) });
    nodes.push({
      type: 'link',
      url: hrefFor(report, m.path, m.line),
      children: [{ type: 'text', value: value.slice(m.start, m.end) }],
    });
    cursor = m.end;
  }
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) });
  return nodes;
}

/** remarkPathLine の設定 */
export interface PathLineOptions {
  /** いま開いているレポートのパス。リンクを開いても、レポートが開いたままになるようにする */
  readonly report: string | null;
}

/**
 * remark のプラグイン: `path:line` をリンクにする
 *
 * コードブロック、既存のリンク(自動リンクを含む)、画像の中は変換しない。
 *
 * @param options 設定
 * @returns mdast の木を書き換える関数
 */
export function remarkPathLine(options: PathLineOptions): (tree: MdNode) => void {
  return (tree) => {
    if (tree.children !== undefined) tree.children = transformChildren(tree.children, options.report);
  };
}
