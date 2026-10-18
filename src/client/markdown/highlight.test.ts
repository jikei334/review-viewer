/**
 * T1-3: シンタックスハイライトの単体テスト(S1-2)
 */
import { describe, expect, it } from 'vitest';
import { prepareHighlighter } from './highlight.js';

describe('prepareHighlighter', () => {
  it('S1-2: 読み込んだ言語は、色つきのトークンに分けられ、連結すると元のコードに戻る', async () => {
    const highlighter = await prepareHighlighter(['typescript']);
    const code = 'export const a: number = 1;\nreturn a;';
    const lines = highlighter.highlight(code, 'typescript');
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(2);
    expect(lines?.[0]?.length).toBeGreaterThan(1);
    expect(lines?.[0]?.some((token) => token.color !== undefined)).toBe(true);
    expect(lines?.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code);
  });

  it('S1-2: 別名(ts)でも読み込める', async () => {
    const highlighter = await prepareHighlighter(['ts']);
    expect(highlighter.highlight('let a = 1;', 'ts')).not.toBeNull();
  });

  it('S1-2: 対応していない言語、読み込んでいない言語は null(装飾なしで表示する)', async () => {
    const highlighter = await prepareHighlighter(['typescript']);
    expect(highlighter.highlight('x', 'no-such-language')).toBeNull();
    expect(highlighter.highlight('x', 'python')).toBeNull();
  });

  it('S1-7: Object.prototype のプロパティ名(constructor など)を言語として扱わない', async () => {
    const highlighter = await prepareHighlighter(['constructor', '__proto__', 'toString']);
    expect(highlighter.highlight('x', 'constructor')).toBeNull();
    expect(highlighter.highlight('x', '__proto__')).toBeNull();
  });

  it('S1-7: トークンの内容は、コードの文字そのまま(HTML の文字列に変換しない)', async () => {
    const highlighter = await prepareHighlighter(['html']);
    const code = '<script>alert(1)</script>';
    const lines = highlighter.highlight(code, 'html');
    expect(lines?.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code);
  });
});
