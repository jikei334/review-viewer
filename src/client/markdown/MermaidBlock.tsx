/**
 * Mermaid の図の描画(S1-3)
 *
 * - `securityLevel: 'strict'`: 図の中の HTML タグをエンコードし、クリックのイベント
 *   (`click` 構文の `javascript:` やコールバック)を無効にする。
 * - 不正な記法のとき(描画が失敗したとき)は、そのブロックだけをエラー表示にする。
 *   ページ全体や、ほかのブロックには影響しない。
 * - Mermaid の本体は大きいので、図があるレポートを開いたときに初めて読み込む。
 */
import { useEffect, useId, useState } from 'react';

/** 描画の結果 */
type RenderState =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly svg: string }
  | { readonly status: 'error'; readonly message: string };

/** Mermaid の初期化を1回だけ行うための入れ物 */
let mermaidPromise: Promise<typeof import('mermaid').default> | undefined;

/**
 * Mermaid を(初回だけ)読み込んで、安全な設定で初期化する
 *
 * @returns 初期化済みの Mermaid
 */
function loadMermaid(): Promise<typeof import('mermaid').default> {
  mermaidPromise ??= import('mermaid').then((module) => {
    const mermaid = module.default;
    mermaid.initialize({
      // スクリプトの実行を許さない設定。図のラベルの HTML は無害化され、click の動作は無効になる
      securityLevel: 'strict',
      startOnLoad: false,
    });
    return mermaid;
  });
  return mermaidPromise;
}

/**
 * 捕まえた値から、画面に出すエラーの説明を作る
 *
 * @param err 捕まえた値
 * @returns 説明(文字列。テキストとして表示する)
 */
function describeRenderError(err: unknown): string {
  return err instanceof Error ? err.message : '原因不明のエラー';
}

/** MermaidBlock の引数 */
export interface MermaidBlockProps {
  /** Mermaid の記法(コードブロックの中身) */
  readonly source: string;
}

/**
 * Mermaid の記法を図として描画する。失敗したら、このブロックだけをエラー表示にする
 *
 * @param props 記法
 * @returns 図、読み込み中の表示、またはエラー表示
 */
export function MermaidBlock({ source }: MermaidBlockProps) {
  // Mermaid が要素の ID として使うので、記号(useId の `:`)を除く
  const id = `mermaid-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const [state, setState] = useState<RenderState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadMermaid()
      .then((mermaid) => mermaid.render(id, source))
      .then(
        (result) => {
          if (!cancelled) setState({ status: 'done', svg: result.svg });
        },
        (err: unknown) => {
          // Mermaid は、描画に失敗すると、作業用の要素(`d` + id)を document.body に残す
          // (エラーの図が画面の端に出てしまう)。自分のブロックの分だけ、片付ける
          document.getElementById(`d${id}`)?.remove();
          if (!cancelled) setState({ status: 'error', message: describeRenderError(err) });
        }
      );
    return () => {
      cancelled = true;
    };
  }, [id, source]);

  if (state.status === 'error') {
    return (
      <div className="mermaid-error" data-testid="mermaid-error" role="alert">
        <strong>Mermaid の図を描画できませんでした</strong>
        <pre>{state.message}</pre>
        <details>
          <summary>記法を表示</summary>
          <pre>{source}</pre>
        </details>
      </div>
    );
  }
  if (state.status === 'loading') {
    return <div className="mermaid-loading">図を描画しています…</div>;
  }
  // 無害化: Mermaid は securityLevel 'strict' のとき、生成した SVG を DOMPurify で無害化してから
  // 返す(mermaid.core.mjs の serializeSvg)。さらに CSP が、インラインのスクリプトを禁止している。
  // この svg 以外の文字列を HTML として挿入しない。
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: state.svg }} />;
}
