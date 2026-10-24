/**
 * コメント API の入力の検証(SPEC §2.2)
 *
 * 副作用のない関数だけを置く。Web API と、ステージ3の MCP の両方から同じ規則で呼ぶ。
 * エラーメッセージは固定の文字列で、受け取った値(本文、パス)を含めない(C-5)。
 */
import type { CommentStatus, CommentType } from './ReviewStore.js';
import { parseCommentPath, parsePathFilter } from './comment-path.js';

/** 本文の上限(UTF-8 のバイト数。32 KiB) */
export const MAX_BODY_BYTES = 32_768;

/** 入力が正しくないときのエラー(HTTP では 400)。メッセージは固定の文字列 */
export class InputError extends Error {
  /**
   * @param message 何が正しくないかの固定の説明(受け取った値を含めない)
   */
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** コメント作成の入力(検証済み) */
export interface CreateCommentInput {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly body: string;
  readonly type: CommentType;
}

/** コメント一覧の絞り込み(指定したものだけ) */
export interface CommentFilter {
  readonly path?: string;
  readonly status?: CommentStatus;
  readonly type?: CommentType;
}

/** 作成リクエストに許すフィールド(`author`、`quote`、`docHash` はサーバーが決めるので受け付けない) */
const CREATE_FIELDS: ReadonlySet<string> = new Set(['path', 'startLine', 'endLine', 'body', 'type']);
/** 状態の値 */
const STATUSES: readonly CommentStatus[] = ['open', 'resolved', 'wontfix'];
/** 種類の値 */
const TYPES: readonly CommentType[] = ['note', 'instruction'];

/**
 * 本文を検証する(空白だけ・長すぎるものを拒否)
 *
 * @param value 本文の候補
 * @returns 検証済みの本文(そのまま。前後の空白は削らない)
 * @throws InputError 文字列でない、空白だけ、32 KiB(UTF-8)超のとき
 */
export function parseBody(value: unknown): string {
  if (typeof value !== 'string') throw new InputError('body は文字列で指定してください');
  if (value.trim() === '') throw new InputError('body が空です');
  if (Buffer.byteLength(value, 'utf8') > MAX_BODY_BYTES) {
    throw new InputError(`body は ${MAX_BODY_BYTES} バイト以下にしてください`);
  }
  return value;
}

/**
 * 種類を検証する
 *
 * @param value 種類の候補
 * @returns `note` または `instruction`
 * @throws InputError それ以外のとき
 */
export function parseType(value: unknown): CommentType {
  const found = TYPES.find((t) => t === value);
  if (found === undefined) throw new InputError('type は note または instruction で指定してください');
  return found;
}

/**
 * 行番号を検証する
 *
 * @param value 行番号の候補
 * @param name フィールド名(エラー用の固定の名前)
 * @returns 1 以上の整数
 * @throws InputError 整数でない、または 1 未満のとき
 */
function parseLine(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InputError(`${name} は 1 以上の整数で指定してください`);
  }
  return value;
}

/**
 * コメント作成のリクエスト(JSON をパースした値)を検証する
 *
 * 行がファイルの行数を超えないことは、ファイルを読む ReviewService が確かめる。
 * `path` の形式の誤りは RepoAccessError(`invalid_path`)で、他のフィールドの誤りは InputError で投げる。
 *
 * @param raw リクエストの JSON
 * @returns 検証済みの入力
 * @throws InputError オブジェクトでない、未知のフィールド(`author` を含む)、必須項目の欠落、型や値の誤り
 * @throws RepoAccessError `path` が正規の形でないとき
 */
export function parseCreateCommentInput(raw: unknown): CreateCommentInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InputError('リクエストは JSON のオブジェクトで指定してください');
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CREATE_FIELDS.has(key)) throw new InputError('指定できないフィールドが含まれています');
  }
  for (const key of CREATE_FIELDS) {
    if (!Object.hasOwn(record, key)) throw new InputError(`${key} が必要です`);
  }
  const rawPath = record['path'];
  if (typeof rawPath !== 'string') throw new InputError('path は文字列で指定してください');
  const startLine = parseLine(record['startLine'], 'startLine');
  const endLine = parseLine(record['endLine'], 'endLine');
  if (startLine > endLine) throw new InputError('startLine は endLine 以下にしてください');
  const body = parseBody(record['body']);
  const type = parseType(record['type']);
  const path = parseCommentPath(rawPath);
  return { path, startLine, endLine, body, type };
}

/**
 * 一覧の絞り込み条件を検証する
 *
 * 値が空文字のものは、指定しなかったものとして扱う(SPEC §2.2)。
 *
 * @param raw クエリの値(省略は undefined)
 * @returns 指定された条件だけを持つ絞り込み
 * @throws InputError `status`・`type` の値が不正なとき
 * @throws RepoAccessError `path` が正規の形でないとき
 */
export function parseCommentFilter(raw: {
  readonly path?: string;
  readonly status?: string;
  readonly type?: string;
}): CommentFilter {
  const path = parsePathFilter(raw.path);
  let status: CommentStatus | undefined;
  if (raw.status !== undefined && raw.status !== '') {
    status = STATUSES.find((s) => s === raw.status);
    if (status === undefined) throw new InputError('status は open / resolved / wontfix のどれかで指定してください');
  }
  let type: CommentType | undefined;
  if (raw.type !== undefined && raw.type !== '') type = parseType(raw.type);
  return {
    ...(path === undefined ? {} : { path }),
    ...(status === undefined ? {} : { status }),
    ...(type === undefined ? {} : { type }),
  };
}
