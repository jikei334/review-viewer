/**
 * コメントの `path` の形式の検証(SPEC §2.2「コメント API の形」、S2-4)
 *
 * 副作用のない関数だけを置く(ファイルシステムには触れない)。実体の確認
 * (存在、拒否対象、シンボリックリンク)は RepoReader の仕事で、ここでは文字列の形だけを見る。
 *
 * 規則: リポジトリ相対の**正規の形**だけを受け付ける。
 * - 形式からリポジトリ外と分かるもの(`..` の要素、絶対パス、NUL などの制御文字、バックスラッシュ)は 400
 * - 正規の形でないもの(先頭の `./`、空の要素 `//`、`.` の要素、末尾の `/`)は、正規化せずに 400
 * - 空文字列は、ファイルを指さないので 400
 * URL のデコードは呼び出し側(HTTP の枠組み)が1回済ませている前提。ここでは追加のデコードをしない。
 */
import { parseRepoPath, RepoAccessError } from './path-policy.js';

/**
 * コメントの `path` が、正規の形かを確かめる
 *
 * @param input 利用者が指定した path
 * @returns 入力と同じ文字列(正規の形であることを確認済み)
 * @throws RepoAccessError 形式が正しくないとき(`invalid_path`。HTTP では 400)
 */
export function parseCommentPath(input: string): string {
  // `..`・絶対パス・制御文字・バックスラッシュ・長すぎるものは、ここで invalid_path になる
  const segments = parseRepoPath(input);
  // `parseRepoPath` は `./` や `//` を取り除いて受け付けるので、取り除いた結果が元と違うものを拒否する
  const canonical = segments.join('/');
  if (segments.length === 0 || canonical !== input) {
    throw new RepoAccessError('invalid_path', 'malformed');
  }
  return input;
}

/**
 * 一覧の `path` 絞り込みの値を検証する
 *
 * 空文字列は「指定なし」。それ以外は `parseCommentPath` と同じ規則。
 *
 * @param input クエリの path の値(省略は undefined)
 * @returns 絞り込みに使う path。指定なし(省略または空)なら undefined
 * @throws RepoAccessError 形式が正しくないとき(`invalid_path`)
 */
export function parsePathFilter(input: string | undefined): string | undefined {
  if (input === undefined || input === '') return undefined;
  return parseCommentPath(input);
}
