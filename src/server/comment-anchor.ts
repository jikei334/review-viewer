/**
 * コメントの位置(anchor)を作るための、純粋関数(SPEC §2.2)
 *
 * 行の数え方は画面の `source-line` と同じ: ファイルの内容を `\n` で分け、末尾の改行の後ろは行にしない。
 * `\r\n` の `\r` は含めない。1 始まり。
 */
import { createHash } from 'node:crypto';

/**
 * ファイルの内容を行に分ける
 *
 * @param content ファイルの内容
 * @returns 行の配列(`\r` を含まない。空のファイルは空の配列)
 */
export function splitLines(content: string): string[] {
  const lines = content.split('\n');
  // 末尾の改行の後ろの空文字列は、行ではない
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * 指定した行範囲の `quote` を作る
 *
 * @param lines 行の配列(`splitLines` の結果)
 * @param startLine 開始行(1 始まり)
 * @param endLine 終了行(1 始まり。開始行以上)
 * @returns 該当行を `\n` でつないだ文字列
 */
export function buildQuote(lines: readonly string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * ファイル内容の SHA-256 を、小文字の16進(64 文字)で返す
 *
 * RepoReader が返した内容(UTF-8 として読めたテキスト。先頭の BOM は除かれている)の UTF-8 表現に対する値。
 *
 * @param content ファイルの内容
 * @returns 64 文字の小文字16進
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
