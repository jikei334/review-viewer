/**
 * T2-6: ステータス遷移・返信の入力の検証の単体テスト(S2-7、S2-8)
 */
import { describe, expect, it } from 'vitest';
import { InputError } from './comment-input.js';
import { parseReplyInput, parseUpdateCommentInput, resolveTransition } from './comment-status.js';
import type { CommentStatus } from './ReviewStore.js';

const ALL: CommentStatus[] = ['open', 'resolved', 'wontfix'];

describe('S2-7: 遷移の規則(resolveTransition)', () => {
  it('S2-7: resolved / wontfix は resolution を送った内容で置き換える(文字列、null、省略)', () => {
    for (const s of ['resolved', 'wontfix'] as const) {
      expect(resolveTransition(s, '説明')).toEqual({ status: s, resolution: '説明' });
      expect(resolveTransition(s, '')).toEqual({ status: s, resolution: '' });
      expect(resolveTransition(s, null)).toEqual({ status: s, resolution: null });
      expect(resolveTransition(s, undefined)).toEqual({ status: s, resolution: null });
    }
  });

  it('S2-7: open は resolution を null にする。open と resolution の併用(null も)は 400', () => {
    expect(resolveTransition('open', undefined)).toEqual({ status: 'open', resolution: null });
    expect(() => resolveTransition('open', 'x')).toThrow(InputError);
    expect(() => resolveTransition('open', null)).toThrow(InputError);
  });

  it('S2-7: resolution が文字列でも null でもなければ 400', () => {
    for (const bad of [1, true, {}, [], ['x']]) {
      expect(() => resolveTransition('resolved', bad)).toThrow(InputError);
    }
  });
});

describe('S2-7: parseUpdateCommentInput', () => {
  it('S2-7: 3 つの値のどれでも受け付ける(遷移元に依存しない。全 9 組の遷移先が成立)', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(from).toBeDefined();
        expect(parseUpdateCommentInput({ status: to }).status).toBe(to);
      }
    }
  });

  it('S2-7: status が無い・3 つ以外・文字列でない値は 400', () => {
    for (const bad of [{}, { status: 'done' }, { status: 'OPEN' }, { status: null }, { status: 1 }, { status: '' }]) {
      expect(() => parseUpdateCommentInput(bad)).toThrow(InputError);
    }
  });

  it('S2-7: body などの未知の項目は 400(本文を編集する手段は無い)', () => {
    for (const extra of ['body', 'author', 'id', 'updatedAt', 'replies', 'path']) {
      expect(() => parseUpdateCommentInput({ status: 'open', [extra]: 'x' })).toThrow(InputError);
    }
  });

  it('S2-7: オブジェクトでない入力は 400', () => {
    for (const bad of [null, [], 'x', 1, undefined]) {
      expect(() => parseUpdateCommentInput(bad)).toThrow(InputError);
    }
  });

  it('S2-7: resolution を明示した null / 省略 / 文字列', () => {
    expect(parseUpdateCommentInput({ status: 'wontfix', resolution: null }).resolution).toBeNull();
    expect(parseUpdateCommentInput({ status: 'wontfix' }).resolution).toBeNull();
    expect(parseUpdateCommentInput({ status: 'resolved', resolution: 'ok' }).resolution).toBe('ok');
    expect(() => parseUpdateCommentInput({ status: 'open', resolution: 'ok' })).toThrow(InputError);
  });

  it('C-5: エラーメッセージに受け取った値を含めない', () => {
    try {
      parseUpdateCommentInput({ status: 'SECRET_SENTINEL' });
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET_SENTINEL');
    }
  });
});

describe('S2-8: parseReplyInput', () => {
  it('S2-8: body だけを受け付ける', () => {
    expect(parseReplyInput({ body: '返信' })).toEqual({ body: '返信' });
  });

  it('S2-8: author などの未知の項目は 400', () => {
    for (const extra of ['author', 'id', 'createdAt']) {
      expect(() => parseReplyInput({ body: 'x', [extra]: 'human' })).toThrow(InputError);
    }
  });

  it('S2-8: body が無い・空・空白だけ・文字列でない・32 KiB 超は 400、ちょうど 32 KiB は可', () => {
    for (const bad of [{}, { body: '' }, { body: ' \n\t' }, { body: 1 }, { body: 'a'.repeat(32_769) }, { body: 'あ'.repeat(10_923) }]) {
      expect(() => parseReplyInput(bad)).toThrow(InputError);
    }
    expect(parseReplyInput({ body: 'a'.repeat(32_768) }).body).toHaveLength(32_768);
  });

  it('S2-8: オブジェクトでない入力は 400', () => {
    for (const bad of [null, [], 'x', 1]) expect(() => parseReplyInput(bad)).toThrow(InputError);
  });
});
