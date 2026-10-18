/**
 * T1-3: 無害化の設定の単体テスト(S1-7)
 *
 * Markdown の変換では生の HTML を解釈しない(要素にならない)ので、危険な要素・属性が
 * 木に現れた場合の振る舞いを、木を直接作って確かめる(二重の守りが効くことの確認)。
 */
import rehypeSanitize from 'rehype-sanitize';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { createSanitizeSchema, SANITIZE_SCHEMA } from './sanitize-schema.js';

/** 無害化の対象にする木(hast)の要素 */
interface TestElement {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: Array<TestElement | { type: 'text'; value: string }>;
}

/**
 * 要素を1つ持つ木を無害化して、JSON の文字列にする
 *
 * @param element 無害化する要素
 * @returns 無害化後の木を JSON にした文字列
 */
function sanitize(element: TestElement): string {
  const processor = unified().use(rehypeSanitize, SANITIZE_SCHEMA);
  const tree = { type: 'root', children: [element] };
  return JSON.stringify(processor.runSync(tree as Parameters<typeof processor.runSync>[0]));
}

/**
 * テスト用の要素を作る
 *
 * @param tagName 要素の名前
 * @param properties 属性(hast の名前。onError など)
 * @param text 子の文字列
 * @returns 要素
 */
function el(tagName: string, properties: Record<string, unknown> = {}, text = 'child'): TestElement {
  return { type: 'element', tagName, properties, children: [{ type: 'text', value: text }] };
}

describe('S1-7: sanitize-schema', () => {
  it.each(['script', 'iframe', 'object', 'embed', 'form', 'style', 'meta', 'link', 'base', 'svg', 'math'])(
    'S1-7: <%s> 要素は取り除かれる',
    (tagName) => {
      expect(sanitize(el(tagName))).not.toContain(`"tagName":"${tagName}"`);
    }
  );

  it('S1-7: script の中身(スクリプト)は、文字としても残らない', () => {
    expect(sanitize(el('script', {}, 'alert(1)'))).not.toContain('alert(1)');
  });

  it('S1-7: on* のイベントハンドラ属性は取り除かれる', () => {
    const result = sanitize(el('img', { src: 'x.png', onError: 'alert(1)', onLoad: 'alert(2)' }));
    expect(result).toContain('"src":"x.png"');
    expect(result).not.toMatch(/onError|onLoad|alert/);
  });

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'vbscript:x', 'data:text/html,x'])(
    'S1-7: a の href が %s のとき、href は取り除かれる',
    (href) => {
      expect(sanitize(el('a', { href }))).not.toMatch(/javascript|vbscript|data:/i);
    }
  );

  it('S1-7: https の href は残る', () => {
    expect(sanitize(el('a', { href: 'https://example.com' }))).toContain('https://example.com');
  });

  it('S1-7: style 属性は取り除かれる', () => {
    expect(sanitize(el('p', { style: 'background:url(javascript:alert(1))' }))).not.toContain('style');
  });

  it('S1-2: input は type=checkbox の checked / disabled だけ残る(タスクリスト)', () => {
    const result = sanitize(el('input', { type: 'checkbox', checked: true, disabled: true }));
    expect(result).toContain('"checked":true');
    expect(result).toContain('"disabled":true');
  });

  it('S1-7: input の type=text は checkbox に直され、onFocus や autoFocus は残らない', () => {
    const result = sanitize(el('input', { type: 'text', onFocus: 'alert(1)', autoFocus: true }));
    expect(result).not.toMatch(/onFocus|autoFocus|alert/);
    expect(result).toContain('"properties":{"disabled":true,"type":"checkbox"}');
  });

  it('S1-7: createSanitizeSchema は既定の設定を書き換えない(checked を足した複製を返す)', () => {
    const first = createSanitizeSchema();
    const second = createSanitizeSchema();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    const input = first.attributes?.input ?? [];
    expect(input).toContain('checked');
    // 何度呼んでも、増えない
    expect(input.filter((item) => item === 'checked')).toHaveLength(1);
  });
});
