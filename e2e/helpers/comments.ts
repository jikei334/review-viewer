/**
 * コメント API(SPEC §2.2)を呼ぶ小さなヘルパー
 */

import { request, tryParseJson, type HttpResult, type HttpTarget } from './http.js';

/** 応答の JSON を、形を決め打ちせずに読むための緩い型(SPEC に無い構造に依存しないため) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonObject = { [key: string]: any };

/**
 * POST /api/comments を、JSON の Content-Type で送る(Origin は付けない。SPEC C-2 により許可される)
 *
 * @param target 接続先
 * @param payload リクエストの JSON(オブジェクト。文字列ならそのまま本文として送る)
 * @param headers 追加のヘッダ(Content-Type を上書きできる)
 * @returns 応答
 */
export function postComment(
  target: HttpTarget,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  return request(target, '/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

/**
 * GET /api/comments を呼ぶ
 *
 * @param target 接続先
 * @param query クエリ文字列('?' なし。エンコード済み)。省略時はクエリなし
 * @returns 応答
 */
export function getComments(target: HttpTarget, query = ''): Promise<HttpResult> {
  return request(target, query === '' ? '/api/comments' : `/api/comments?${query}`);
}

/**
 * 応答の本文を JSON として読み、`comments` 配列を返す。読めなければ例外を投げる
 *
 * @param res GET /api/comments の応答
 * @returns コメントの配列
 */
export function commentsOf(res: HttpResult): Array<JsonObject> {
  const parsed = tryParseJson(res.text);
  if (!parsed.ok) throw new Error(`JSON ではありません(${res.status}): ${res.text.slice(0, 200)}`);
  const value = parsed.value as { comments?: unknown };
  if (value === null || typeof value !== 'object' || !Array.isArray(value.comments)) {
    throw new Error(`{ comments: [...] } の形ではありません(${res.status}): ${res.text.slice(0, 200)}`);
  }
  return value.comments as Array<JsonObject>;
}

/**
 * 応答の本文を JSON として読み、オブジェクトを返す。読めなければ例外を投げる
 *
 * @param res 応答
 * @returns JSON のオブジェクト
 */
export function jsonOf(res: HttpResult): JsonObject {
  const parsed = tryParseJson(res.text);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') {
    throw new Error(`JSON のオブジェクトではありません(${res.status}): ${res.text.slice(0, 200)}`);
  }
  return parsed.value as JsonObject;
}

/**
 * PATCH /api/comments/:id を、JSON の Content-Type で送る(Origin は付けない)
 *
 * @param target 接続先
 * @param id コメントの ID(そのままパスに入れる。エンコード済みであること)
 * @param payload リクエストの JSON(文字列ならそのまま本文として送る)
 * @param headers 追加のヘッダ(Content-Type を上書きできる)
 * @returns 応答
 */
export function patchComment(
  target: HttpTarget,
  id: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  return request(target, `/api/comments/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

/**
 * POST /api/comments/:id/replies を、JSON の Content-Type で送る(Origin は付けない)
 *
 * @param target 接続先
 * @param id コメントの ID(そのままパスに入れる。エンコード済みであること)
 * @param payload リクエストの JSON(文字列ならそのまま本文として送る)
 * @param headers 追加のヘッダ(Content-Type を上書きできる)
 * @returns 応答
 */
export function postReply(
  target: HttpTarget,
  id: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  return request(target, `/api/comments/${id}/replies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}
