/**
 * レポート1件の表示
 *
 * ファイルを取得し、コードブロックの文法を読み込んでから、Markdown を描画する。
 * 文法の読み込みを待つのは、描画した時点でシンタックスハイライトが済んでいるようにするため。
 */
import { useEffect, useState } from 'react';
import { fetchFile, type FileResult } from './api.js';
import { extractCodeLanguages } from './markdown/code-languages.js';
import { prepareHighlighter, type CodeHighlighter } from './markdown/highlight.js';
import { MarkdownView } from './markdown/MarkdownView.js';

/** 表示の状態 */
type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'unreadable'; readonly message: string }
  | { readonly status: 'ready'; readonly source: string; readonly highlighter: CodeHighlighter };

/**
 * ファイルを取得して、表示できる状態にする
 *
 * @param path リポジトリ相対パス
 * @returns 表示の状態(loading 以外)
 */
async function loadReport(path: string): Promise<ViewState> {
  let file: FileResult;
  try {
    file = await fetchFile(path);
  } catch (err) {
    console.error('Review Viewer: レポートを取得できませんでした', err);
    return { status: 'error', message: 'レポートを開けませんでした' };
  }
  if (file.kind === 'too_large') {
    return { status: 'unreadable', message: 'ファイルが大きすぎるため、表示できません' };
  }
  if (file.kind === 'binary') {
    return { status: 'unreadable', message: 'バイナリファイルは表示できません' };
  }
  const highlighter = await prepareHighlighter(extractCodeLanguages(file.content));
  return { status: 'ready', source: file.content, highlighter };
}

/** ReportView の引数 */
export interface ReportViewProps {
  /** 開くレポートのリポジトリ相対パス */
  readonly path: string;
}

/**
 * レポートを表示する
 *
 * @param props 開くレポートのパス
 * @returns 本文(`data-testid="report-content"`)、または読み込み中・エラーの表示
 */
export function ReportView({ path }: ReportViewProps) {
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadReport(path).then(
      (next) => {
        if (!cancelled) setState(next);
      },
      (err: unknown) => {
        console.error('Review Viewer: レポートの準備に失敗しました', err);
        if (!cancelled) setState({ status: 'error', message: 'レポートを表示できませんでした' });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (state.status === 'loading') return <p className="status">読み込み中…</p>;
  if (state.status === 'error' || state.status === 'unreadable') {
    return (
      <p className="status error" role="alert">
        {state.message}
      </p>
    );
  }
  return (
    <article className="markdown-body" data-testid="report-content">
      <MarkdownView source={state.source} highlighter={state.highlighter} reportPath={path} />
    </article>
  );
}
