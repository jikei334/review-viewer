/**
 * T2-3: コメント API の入力の検証の単体テスト(SPEC §2.2、S2-1、S2-4)
 */
import { describe, expect, it } from 'vitest';
import {
  InputError,
  MAX_BODY_BYTES,
  parseBody,
  parseCommentFilter,
  parseCreateCommentInput,
  parseType,
} from './comment-input.js';
import { RepoAccessError } from './path-policy.js';

/**
 * 有効な作成リクエストを作る
 *
 * @param over 上書きする項目
 * @returns リクエストの値
 */
function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { path: 'src/a.ts', startLine: 1, endLine: 2, body: 'メモ', type: 'note', ...over };
}

describe('S2-1: parseCreateCommentInput', () => {
  it('S2-1: 有効な入力をそのまま返す', () => {
    expect(parseCreateCommentInput(valid())).toEqual({
      path: 'src/a.ts',
      startLine: 1,
      endLine: 2,
      body: 'メモ',
      type: 'note',
    });
  });

  it('S2-1: startLine と endLine が同じ(1 行)でもよい', () => {
    expect(parseCreateCommentInput(valid({ startLine: 3, endLine: 3 })).endLine).toBe(3);
  });

  it('S2-1: type は instruction も受け付ける', () => {
    expect(parseCreateCommentInput(valid({ type: 'instruction' })).type).toBe('instruction');
  });

  it('S2-1: 本文の前後の空白は削らない', () => {
    expect(parseCreateCommentInput(valid({ body: '  x\n' })).body).toBe('  x\n');
  });

  const missing = ['path', 'startLine', 'endLine', 'body', 'type'];
  it.each(missing)('S2-1: %s の欠落は InputError', (key) => {
    const p = valid();
    delete p[key];
    expect(() => parseCreateCommentInput(p)).toThrow(InputError);
  });

  it.each([
    ['author=human', { author: 'human' }],
    ['author=ai', { author: 'ai' }],
    ['quote', { quote: 'x' }],
    ['docHash', { docHash: 'x' }],
    ['未知のフィールド', { extra: 1 }],
    ['__proto__ を持つ', JSON.parse('{"__proto__": {}}') as Record<string, unknown>],
  ])('S2-1: %s を含むと InputError(サーバーが決める項目は受け付けない)', (_label, extra) => {
    const p = { ...valid(), ...extra };
    expect(() => parseCreateCommentInput(p)).toThrow(InputError);
  });

  it.each([
    ['startLine が文字列', { startLine: '1' }],
    ['startLine が小数', { startLine: 1.5 }],
    ['startLine が 0', { startLine: 0 }],
    ['startLine が負', { startLine: -1 }],
    ['startLine が NaN 相当(null)', { startLine: null }],
    ['startLine が巨大', { startLine: 2 ** 60 }],
    ['endLine が小数', { endLine: 2.5 }],
    ['endLine が 0', { endLine: 0 }],
    ['startLine > endLine', { startLine: 3, endLine: 2 }],
    ['type が範囲外', { type: 'question' }],
    ['type が数値', { type: 1 }],
    ['path が数値', { path: 1 }],
    ['body が数値', { body: 1 }],
    ['body がオブジェクト', { body: { a: 1 } }],
    ['body が空', { body: '' }],
    ['body が空白だけ', { body: ' \n\t\r\n ' }],
    ['body が全角空白だけ', { body: '　　' }],
    ['body が 32 KiB 超', { body: 'a'.repeat(MAX_BODY_BYTES + 1) }],
    ['body が UTF-8 で 32 KiB 超(文字数は以下)', { body: 'あ'.repeat(10_923) }],
  ])('S2-1: %s は InputError', (_label, over) => {
    expect(() => parseCreateCommentInput(valid(over))).toThrow(InputError);
  });

  it.each([null, undefined, [], 'text', 1, true])('S2-1: オブジェクトでない入力(%j)は InputError', (raw) => {
    expect(() => parseCreateCommentInput(raw)).toThrow(InputError);
  });

  it('S2-1: 本文がちょうど 32 KiB(マルチバイトを含む)は受け付ける', () => {
    const body = 'あ'.repeat(10_922) + 'aa';
    expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_BODY_BYTES);
    expect(parseCreateCommentInput(valid({ body })).body).toBe(body);
  });

  it.each(['../x', '/abs', './a.ts', 'a//b', 'a/', 'a\\b', 'a\u0000b', ''])(
    'S2-4: 正規の形でない path(%j)は RepoAccessError(invalid_path)',
    (path) => {
      expect(() => parseCreateCommentInput(valid({ path }))).toThrow(RepoAccessError);
    }
  );

  it('C-5: エラーのメッセージに、受け取った値(本文・パス)を含めない', () => {
    for (const p of [valid({ body: '   ', path: 'SECRET_PATH' }), valid({ extra: 'SECRET_VALUE' }), valid({ startLine: 'SECRET_LINE' })]) {
      try {
        parseCreateCommentInput(p);
        expect.unreachable();
      } catch (err: unknown) {
        expect((err as Error).message).not.toMatch(/SECRET/);
      }
    }
  });
});

describe('S2-1: parseBody / parseType', () => {
  it('S2-1: parseBody は空白だけを拒否する', () => {
    expect(() => parseBody('  ')).toThrow(InputError);
    expect(parseBody('a')).toBe('a');
  });
  it('S2-1: parseType は note / instruction だけ', () => {
    expect(parseType('note')).toBe('note');
    expect(parseType('instruction')).toBe('instruction');
    expect(() => parseType('Note')).toThrow(InputError);
    expect(() => parseType(undefined)).toThrow(InputError);
  });
});

describe('S2-1・S2-4: parseCommentFilter', () => {
  it('S2-1: 何も指定しなければ空の絞り込み', () => {
    expect(parseCommentFilter({})).toEqual({});
  });

  it('S2-1: 空文字の値は、指定しなかったものとして扱う', () => {
    expect(parseCommentFilter({ path: '', status: '', type: '' })).toEqual({});
  });

  it('S2-1: 指定したものだけを持つ', () => {
    expect(parseCommentFilter({ path: 'a.ts', status: 'open', type: 'instruction' })).toEqual({
      path: 'a.ts',
      status: 'open',
      type: 'instruction',
    });
    expect(parseCommentFilter({ status: 'wontfix' })).toEqual({ status: 'wontfix' });
  });

  it.each(['bogus', 'OPEN', 'Resolved', ' open'])('S2-1: status=%j は InputError', (status) => {
    expect(() => parseCommentFilter({ status })).toThrow(InputError);
  });

  it.each(['bogus', 'Note', 'question'])('S2-1: type=%j は InputError', (type) => {
    expect(() => parseCommentFilter({ type })).toThrow(InputError);
  });

  it.each(['../x', '/abs', 'a\u0000', 'a/', './a', 'a//b'])('S2-4: path=%j は RepoAccessError(invalid_path)', (path) => {
    expect(() => parseCommentFilter({ path })).toThrow(RepoAccessError);
  });
});
