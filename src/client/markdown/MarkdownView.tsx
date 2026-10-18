/**
 * Markdown の表示(S1-2、S1-3、S1-7)
 *
 * - react-markdown: Markdown を React の要素に変換する。HTML の文字列を作って挿入しない
 * - remark-gfm: 表・タスクリスト・取り消し線
 * - rehype-sanitize: 変換後の HTML(hast)を無害化する(S1-7)。
 *   Markdown の中の生の HTML は、そもそも解釈しない(rehype-raw を使わない)ので、
 *   `<script>` などは要素にならない。無害化は、それでも残る要素と属性に対する二重の守り
 * - コードブロック: shiki でトークンに分け、`span` 要素として描画する
 * - ```mermaid ブロック: 図として描画する
 */
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { MERMAID_LANGUAGE } from './code-languages.js';
import type { CodeHighlighter } from './highlight.js';
import { MermaidBlock } from './MermaidBlock.js';
import { SANITIZE_SCHEMA } from './sanitize-schema.js';

/** コードブロックの内容 */
interface CodeBlock {
  /** 言語名(小文字。指定が無ければ undefined) */
  readonly lang: string | undefined;
  /** コード(末尾の改行を1つ除いたもの) */
  readonly text: string;
}

/** `language-xxx` のクラス名から言語名を取り出す形 */
const LANGUAGE_CLASS = /(?:^|\s)language-(\S+)/;

/**
 * `pre` の子(`code` 要素)から、コードブロックの内容を取り出す
 *
 * @param children `pre` の子
 * @returns コードブロックの内容。`code` 要素でなければ null
 */
function readCodeBlock(children: ReactNode): CodeBlock | null {
  const [child] = Children.toArray(children);
  if (!isValidElement(child)) return null;
  const props = (child as ReactElement<{ className?: unknown; children?: unknown }>).props;
  if (typeof props.children !== 'string' && props.children !== undefined) return null;
  const className = typeof props.className === 'string' ? props.className : '';
  const lang = LANGUAGE_CLASS.exec(className)?.[1]?.toLowerCase();
  const raw = props.children ?? '';
  return { lang, text: raw.endsWith('\n') ? raw.slice(0, -1) : raw };
}

/** HighlightedCode の引数 */
interface HighlightedCodeProps {
  /** コードブロックの内容 */
  readonly block: CodeBlock;
  /** ハイライタ */
  readonly highlighter: CodeHighlighter;
}

/**
 * コードブロックを `pre > code` として描画する。ハイライトできるなら `span` で色をつける
 *
 * @param props コードブロックとハイライタ
 * @returns `pre` 要素
 */
function HighlightedCode({ block, highlighter }: HighlightedCodeProps) {
  const className = block.lang === undefined ? undefined : `language-${block.lang}`;
  const lines = block.lang === undefined ? null : highlighter.highlight(block.text, block.lang);
  if (lines === null) {
    return (
      <pre>
        <code className={className}>{block.text}</code>
      </pre>
    );
  }
  return (
    <pre>
      <code className={className}>
        {lines.map((tokens, lineIndex) => (
          // 行の並びは変わらない(再描画のたびに作り直す)ので、添字をキーにしてよい
          <span className="code-line" key={lineIndex}>
            {tokens.map((token, tokenIndex) => (
              <span key={tokenIndex} style={token.color === undefined ? undefined : { color: token.color }}>
                {token.content}
              </span>
            ))}
            {lineIndex < lines.length - 1 ? '\n' : ''}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** MarkdownView の引数 */
export interface MarkdownViewProps {
  /** Markdown の本文 */
  readonly source: string;
  /** コードブロックに使う、読み込み済みのハイライタ */
  readonly highlighter: CodeHighlighter;
}

/**
 * Markdown を描画する
 *
 * @param props 本文とハイライタ
 * @returns 変換した要素
 */
export function MarkdownView({ source, highlighter }: MarkdownViewProps) {
  const components: Components = {
    pre({ children }) {
      const block = readCodeBlock(children);
      if (block === null) return <pre>{children}</pre>;
      if (block.lang === MERMAID_LANGUAGE) return <MermaidBlock source={block.text} />;
      return <HighlightedCode block={block} highlighter={highlighter} />;
    },
  };
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}
      components={components}
    >
      {source}
    </Markdown>
  );
}
