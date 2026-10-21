/**
 * T2-3: anchor を作る純粋関数の単体テスト(SPEC §2.2、S2-1)
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildQuote, hashContent, splitLines } from './comment-anchor.js';

describe('S2-1: splitLines', () => {
  it.each([
    ['空のファイル', '', []],
    ['改行だけ', '\n', ['']],
    ['末尾の改行の後ろは行にしない', 'a\nb\n', ['a', 'b']],
    ['末尾の改行が無い', 'a\nb', ['a', 'b']],
    ['空行を含む', 'a\n\nb\n', ['a', '', 'b']],
    ['CRLF の \\r を含めない', 'a\r\nb\r\n', ['a', 'b']],
    ['行の途中の \\r は残す', 'a\rb\n', ['a\rb']],
    ['末尾の改行が連続', 'a\n\n', ['a', '']],
  ])('S2-1: %s', (_label, content, expected) => {
    expect(splitLines(content)).toEqual(expected);
  });
});

describe('S2-1: buildQuote', () => {
  const lines = ['one', 'two', 'three', 'four'];
  it('S2-1: 1 行', () => {
    expect(buildQuote(lines, 2, 2)).toBe('two');
  });
  it('S2-1: 複数行は \\n でつなぐ', () => {
    expect(buildQuote(lines, 2, 4)).toBe('two\nthree\nfour');
  });
  it('S2-1: 先頭と末尾の行', () => {
    expect(buildQuote(lines, 1, 4)).toBe('one\ntwo\nthree\nfour');
  });
});

describe('S2-1: hashContent', () => {
  it('S2-1: SHA-256 の全体を小文字の16進 64 文字で返す', () => {
    const h = hashContent('hello\n');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHash('sha256').update('hello\n').digest('hex'));
  });
  it('S2-1: マルチバイトは UTF-8 のバイト列で計算する', () => {
    expect(hashContent('あ')).toBe(createHash('sha256').update(Buffer.from('あ', 'utf8')).digest('hex'));
  });
  it('S2-1: 内容が違えば値も違う', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});
