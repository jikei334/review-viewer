/**
 * シンタックスハイライト(shiki)
 *
 * shiki は、コードを「色つきの部分文字列(トークン)」に分けて返す。HTML の文字列は作らず、
 * React が `span` 要素として描画する(HTML の文字列を挿入しないので、コードの中身がタグとして
 * 解釈されることはない)。
 * 正規表現のエンジンは JavaScript 版を使う(WASM を配信しない)。
 */
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguages } from 'shiki/langs';
import { bundledThemes } from 'shiki/themes';

/** 使うテーマ */
const THEME = 'github-light';

/** 描画の時点で使える、同期のハイライタ */
export interface CodeHighlighter {
  /**
   * コードをトークンに分ける
   *
   * @param code コード(末尾の改行は含めない)
   * @param lang 言語名
   * @returns 行ごとのトークン。この言語を読み込んでいない、または対応していなければ null
   */
  highlight(code: string, lang: string): ThemedToken[][] | null;
}

/** 何もしないハイライタ(すべてのコードを装飾なしで表示する。テストと失敗時の代替) */
export const PLAIN_HIGHLIGHTER: CodeHighlighter = {
  highlight: () => null,
};

/** 読み込み済みのハイライタ(最初の呼び出しで作る) */
let corePromise: Promise<HighlighterCore> | undefined;

/**
 * shiki のハイライタを(初回だけ)作る
 *
 * @returns ハイライタ
 */
function getCore(): Promise<HighlighterCore> {
  corePromise ??= createHighlighterCore({
    themes: [bundledThemes[THEME]],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return corePromise;
}

/**
 * 言語名が shiki の対応している言語かを調べる
 *
 * @param lang 言語名(小文字)
 * @returns 対応していれば true
 */
function isSupportedLanguage(lang: string): boolean {
  return Object.hasOwn(bundledLanguages, lang);
}

/**
 * 指定した言語を読み込んで、同期で使えるハイライタを返す
 *
 * 対応していない言語は読み込まない(その言語のコードは装飾なしで表示される)。
 * 文法の読み込みに失敗した言語も、装飾なしで表示する(レポート全体は表示する)。失敗は
 * コンソールに残す。
 *
 * @param languages 言語名の一覧(小文字)
 * @returns 同期で使えるハイライタ
 */
export async function prepareHighlighter(languages: readonly string[]): Promise<CodeHighlighter> {
  const core = await getCore();
  const supported = languages.filter(isSupportedLanguage);
  const results = await Promise.allSettled(
    supported.map((lang) => core.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages]))
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Review Viewer: 言語 ${supported[index]} の文法を読み込めませんでした`, result.reason);
    }
  });
  return {
    highlight: (code, lang) => {
      if (!isSupportedLanguage(lang) || !core.getLoadedLanguages().includes(lang)) return null;
      return core.codeToTokensBase(code, { lang, theme: THEME });
    },
  };
}
