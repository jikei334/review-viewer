/**
 * ソース表示のための純粋関数(行の分割、言語の判定、ハイライトするかの判定)
 */

/** ハイライトする本文の上限(文字数)。暫定: SPEC に規定なし。大きいファイルで画面が固まるのを避ける */
export const MAX_HIGHLIGHT_LENGTH = 200_000;

/** 拡張子と shiki の言語名の対応(暫定: よく使うものだけ。無いものは装飾なしで表示する) */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'bash',
  bash: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  toml: 'toml',
  sql: 'sql',
  xml: 'xml',
  rb: 'ruby',
};

/**
 * 本文を行に分ける(CRLF・CR・LF に対応)
 *
 * 末尾の改行は、空の行を作らない(`a\nb\n` は 2 行)。空の本文は 0 行。
 *
 * @param content ファイルの本文
 * @returns 行の配列(行番号は添字 + 1)
 */
export function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * パスの拡張子から、ハイライトの言語名を決める
 *
 * @param path リポジトリ相対パス
 * @returns 言語名。対応が無ければ null
 */
export function languageForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(LANGUAGE_BY_EXTENSION, extension) ? (LANGUAGE_BY_EXTENSION[extension] ?? null) : null;
}

/**
 * 本文をハイライトしてよいかを判定する
 *
 * @param content ファイルの本文
 * @returns 上限以下なら true
 */
export function shouldHighlight(content: string): boolean {
  return content.length <= MAX_HIGHLIGHT_LENGTH;
}
