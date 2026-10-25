/**
 * コメントのステータス変更・返信の入力の検証と、遷移の規則(SPEC §2.1、§2.2)
 *
 * 副作用のない関数だけを置く。Web API と、ステージ3の MCP の両方から同じ規則で呼ぶ。
 * エラーメッセージは固定の文字列で、受け取った値(本文)を含めない(C-5)。
 */
import { InputError, parseBody } from './comment-input.js';
import type { CommentStatus } from './ReviewStore.js';

/** ステータス変更の入力(検証済み) */
export interface UpdateCommentInput {
  readonly status: CommentStatus;
  /** `resolved` / `wontfix` のときの説明(省略は null)。`open` のときは常に null */
  readonly resolution: string | null;
}

/** 返信の入力(検証済み。作者はサーバーが決める) */
export interface ReplyInput {
  readonly body: string;
}

/** 状態の値 */
const STATUSES: readonly CommentStatus[] = ['open', 'resolved', 'wontfix'];

/**
 * 値が、プレーンなオブジェクトか
 *
 * @param value 調べる値
 * @returns オブジェクト(配列と null を除く)なら true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ステータス変更の遷移を決める(どの値からどの値へも可。同じ値も可)
 *
 * `open` のとき resolution は null で、resolution を一緒に送ると誤り。
 * `resolved` / `wontfix` のとき resolution は、送った内容で置き換わる(省略・null は null)。
 *
 * @param status 変更後の状態
 * @param resolution 送られた resolution(省略は undefined)
 * @returns 保存する status と resolution
 * @throws InputError open と一緒に resolution が送られた、または resolution が文字列・null でないとき
 */
export function resolveTransition(status: CommentStatus, resolution: unknown): UpdateCommentInput {
  if (status === 'open') {
    if (resolution !== undefined) throw new InputError('open のときは resolution を指定できません');
    return { status, resolution: null };
  }
  if (resolution === undefined || resolution === null) return { status, resolution: null };
  if (typeof resolution !== 'string') throw new InputError('resolution は文字列または null で指定してください');
  return { status, resolution };
}

/**
 * PATCH /api/comments/:id のリクエスト(JSON をパースした値)を検証する
 *
 * @param raw リクエストの JSON
 * @returns 検証済みの入力
 * @throws InputError オブジェクトでない、`status` が無い・3つの値以外、`status` と `resolution` 以外の項目(`body` を含む)、resolution の誤り
 */
export function parseUpdateCommentInput(raw: unknown): UpdateCommentInput {
  if (!isRecord(raw)) throw new InputError('リクエストは JSON のオブジェクトで指定してください');
  for (const key of Object.keys(raw)) {
    if (key !== 'status' && key !== 'resolution') throw new InputError('指定できないフィールドが含まれています');
  }
  if (!Object.hasOwn(raw, 'status')) throw new InputError('status が必要です');
  const status = STATUSES.find((s) => s === raw['status']);
  if (status === undefined) throw new InputError('status は open / resolved / wontfix のどれかで指定してください');
  return resolveTransition(status, Object.hasOwn(raw, 'resolution') ? raw['resolution'] : undefined);
}

/**
 * 返信のリクエスト(JSON をパースした値)を検証する
 *
 * @param raw リクエストの JSON
 * @returns 検証済みの入力
 * @throws InputError オブジェクトでない、`body` 以外の項目(`author` を含む)、`body` が無い・空・空白だけ・32 KiB 超のとき
 */
export function parseReplyInput(raw: unknown): ReplyInput {
  if (!isRecord(raw)) throw new InputError('リクエストは JSON のオブジェクトで指定してください');
  for (const key of Object.keys(raw)) {
    if (key !== 'body') throw new InputError('指定できないフィールドが含まれています');
  }
  if (!Object.hasOwn(raw, 'body')) throw new InputError('body が必要です');
  return { body: parseBody(raw['body']) };
}
