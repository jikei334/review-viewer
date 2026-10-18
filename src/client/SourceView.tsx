/**
 * ソース1ファイルの表示(行番号つき、シンタックスハイライトつき)
 *
 * shiki のトークンを `span` として描画する。HTML の文字列は作らず、挿入もしない。
 */
import type { ThemedToken } from 'shiki/core';
import { useEffect, useRef, useState } from 'react';
import { fetchFile } from './api.js';
import { prepareHighlighter } from './markdown/highlight.js';
import { languageForPath, shouldHighlight, splitLines } from './source-lines.js';

/** 表示の状態 */
export type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'unreadable'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly lines: readonly string[];
      /** 行ごとのトークン。ハイライトしない(できない)ときは null */
      readonly tokens: readonly (readonly ThemedToken[])[] | null;
    };

/**
 * ファイルを取得して、表示できる状態にする
 *
 * @param path リポジトリ相対パス
 * @returns 表示の状態(loading 以外)
 */
export async function loadSource(path: string): Promise<ViewState> {
  let file;
  try {
    file = await fetchFile(path);
  } catch (err) {
    console.error('Review Viewer: ソースを取得できませんでした', err);
    return { status: 'error', message: 'ファイルを開けませんでした' };
  }
  if (file.kind === 'too_large') {
    return { status: 'unreadable', message: 'ファイルが大きすぎるため、表示できません' };
  }
  if (file.kind === 'binary') {
    return { status: 'unreadable', message: 'バイナリファイルは表示できません' };
  }
  const lines = splitLines(file.content);
  const lang = languageForPath(path);
  let tokens: readonly (readonly ThemedToken[])[] | null = null;
  if (lang !== null && shouldHighlight(file.content)) {
    const highlighter = await prepareHighlighter([lang]);
    tokens = highlighter.highlight(lines.join('\n'), lang);
  }
  return { status: 'ready', lines, tokens };
}

/** SourceLines の引数 */
export interface SourceLinesProps {
  /** 行(行番号は添字 + 1) */
  readonly lines: readonly string[];
  /** 行ごとのトークン。null なら装飾なし */
  readonly tokens: readonly (readonly ThemedToken[])[] | null;
  /** 強調表示する行番号(1 始まり)。無ければ null */
  readonly highlightedLine: number | null;
}

/**
 * 行番号つきのコードを描画する
 *
 * @param props 行、トークン、強調表示する行
 * @returns 各行(`data-testid="source-line"` と `data-line`)の並び
 */
export function SourceLines({ lines, tokens, highlightedLine }: SourceLinesProps) {
  return (
    <div className="source-lines">
      {lines.map((text, index) => {
        const lineNumber = index + 1;
        const lineTokens = tokens?.[index];
        return (
          <div
            key={lineNumber}
            data-testid="source-line"
            data-line={lineNumber}
            data-highlighted={lineNumber === highlightedLine ? 'true' : undefined}
            className="source-line"
          >
            <span className="line-number" data-testid="source-line-number">
              {lineNumber}
            </span>
            <code className="line-text">
              {lineTokens === undefined
                ? text
                : lineTokens.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={token.color === undefined ? undefined : { color: token.color }}>
                      {token.content}
                    </span>
                  ))}
            </code>
          </div>
        );
      })}
    </div>
  );
}

/** SourceView の引数 */
export interface SourceViewProps {
  /** 開くファイルのリポジトリ相対パス */
  readonly path: string;
  /** 強調表示して移動する行(1 始まり)。無ければ null */
  readonly line: number | null;
}

/**
 * ソースを表示する
 *
 * @param props 開くファイルと、強調表示する行
 * @returns ソース表示エリア(`data-testid="source-view"`)
 */
export function SourceView({ path, line }: SourceViewProps) {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadSource(path).then(
      (next) => {
        if (!cancelled) setState(next);
      },
      (err: unknown) => {
        console.error('Review Viewer: ソースの準備に失敗しました', err);
        if (!cancelled) setState({ status: 'error', message: 'ファイルを表示できませんでした' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  // 描画が済んだら、強調表示する行までスクロールする
  useEffect(() => {
    if (state.status !== 'ready' || line === null) return;
    const target = rootRef.current?.querySelector(`[data-testid="source-line"][data-line="${String(line)}"]`);
    target?.scrollIntoView({ block: 'center' });
  }, [state, line]);

  return (
    <section data-testid="source-view" className="source-view" ref={rootRef}>
      <h2 className="source-path">{path}</h2>
      {state.status === 'loading' && <p className="status">読み込み中…</p>}
      {(state.status === 'error' || state.status === 'unreadable') && (
        <p className="status error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === 'ready' && <SourceLines lines={state.lines} tokens={state.tokens} highlightedLine={line} />}
    </section>
  );
}
