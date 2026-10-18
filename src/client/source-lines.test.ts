/**
 * T1-4: 行の分割・言語判定の単体テスト
 */
import { describe, expect, it } from 'vitest';
import { languageForPath, MAX_HIGHLIGHT_LENGTH, shouldHighlight, splitLines } from './source-lines.js';

describe('splitLines', () => {
  it('S1-8: 行に分ける。末尾の改行は空の行を作らない', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });
  it('S1-8: 途中の空行は残す', () => {
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
  });
  it('S1-8: CRLF と CR も改行として扱う', () => {
    expect(splitLines('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
  });
  it('S1-8: 空の本文は 0 行', () => {
    expect(splitLines('')).toEqual([]);
  });
});

describe('languageForPath', () => {
  it('S1-8: 拡張子から言語を決める', () => {
    expect(languageForPath('src/a.ts')).toBe('typescript');
    expect(languageForPath('x/Y.PY')).toBe('python');
  });
  it('S1-8: 対応の無い拡張子、拡張子なし、隠しファイルは null', () => {
    expect(languageForPath('a.unknownext')).toBeNull();
    expect(languageForPath('src/Makefile')).toBeNull();
    expect(languageForPath('.gitignore')).toBeNull();
    expect(languageForPath('a.constructor')).toBeNull();
  });
});

describe('shouldHighlight', () => {
  it('S1-8: 上限を超える本文はハイライトしない', () => {
    expect(shouldHighlight('a'.repeat(MAX_HIGHLIGHT_LENGTH))).toBe(true);
    expect(shouldHighlight('a'.repeat(MAX_HIGHLIGHT_LENGTH + 1))).toBe(false);
  });
});
