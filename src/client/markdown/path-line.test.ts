/**
 * T1-5: `path:line` 参照の検出とリンク化の単体テスト(S1-8)
 */
import { describe, expect, it } from 'vitest';
import { findPathLines, remarkPathLine } from './path-line.js';

/**
 * 文字列から見つけた参照を、`パス:行` の文字列の並びにする
 *
 * @param text 調べる文字列
 * @returns 見つけた参照
 */
function refs(text: string): string[] {
  return findPathLines(text).map((m) => `${m.path}:${String(m.line)}`);
}

describe('findPathLines', () => {
  it('S1-8: src/foo.ts:42 を見つける', () => {
    const [m] = findPathLines('see src/foo.ts:42 now');
    expect(m).toEqual({ start: 4, end: 17, path: 'src/foo.ts', line: 42 });
  });
  it('S1-8: 行番号 0 は見つけない', () => {
    expect(refs('foo.ts:0')).toEqual([]);
    expect(refs('src/foo.ts:00')).toEqual([]);
  });
  it('S1-8: 参照のない文章は見つけない', () => {
    expect(refs('これは普通の文章です。')).toEqual([]);
    expect(refs('src/foo.ts を見てください')).toEqual([]);
  });
  it('S1-8: 末尾の句読点・括弧を含めない', () => {
    expect(refs('(src/a.ts:3).')).toEqual(['src/a.ts:3']);
    expect(refs('src/a.ts:3, src/b.ts:4.')).toEqual(['src/a.ts:3', 'src/b.ts:4']);
    expect(refs('src/a.ts:3。')).toEqual(['src/a.ts:3']);
  });
  it('S1-8: 日本語の文章に隣接していても、パス部分だけを取る', () => {
    expect(refs('実装はsrc/a.ts:3にある')).toEqual(['src/a.ts:3']);
  });
  it('S1-8: ディレクトリ区切り・ドット・ハイフンを含むパス', () => {
    expect(refs('src/server/index.ts:15')).toEqual(['src/server/index.ts:15']);
    expect(refs('./a-b/c_d.test.tsx:7')).toEqual(['./a-b/c_d.test.tsx:7']);
    expect(refs('Makefile.am:2')).toEqual(['Makefile.am:2']);
  });
  it('S1-8: URL の中の : は参照にしない', () => {
    expect(refs('https://example.com:8080/a')).toEqual([]);
    expect(refs('https://example.com/a/b.ts:3')).toEqual([]);
    expect(refs('http://localhost:3000')).toEqual([]);
  });
  it('S1-8: 時刻・ポート番号など、ファイルらしくないものは参照にしない', () => {
    expect(refs('12:30')).toEqual([]);
    expect(refs('localhost:8080')).toEqual([]);
  });
  it('S1-8: 行番号のあとに英数字が続くものは参照にしない', () => {
    expect(refs('src/a.ts:12abc')).toEqual([]);
  });
  it('S1-8: 桁あふれする長い行番号は参照にしない', () => {
    expect(refs('src/a.ts:12345678901')).toEqual([]);
  });
  it('S1-8: 行:桁 の形は、行までを参照にする', () => {
    expect(refs('src/a.ts:42:10')).toEqual(['src/a.ts:42']);
  });
  it('S1-8: 先頭が / の絶対パスは参照にしない', () => {
    expect(refs('/etc/passwd:1')).toEqual([]);
  });
});

/** テストで使う mdast の最小の型 */
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

/**
 * プラグインを適用した木を返す
 *
 * @param children ルートの子
 * @param report レポートのパス
 * @returns 適用後のルート
 */
function apply(children: Node[], report: string | null = 'reports/a.md'): Node {
  const tree: Node = { type: 'root', children };
  remarkPathLine({ report })(tree);
  return tree;
}

describe('remarkPathLine', () => {
  it('S1-8: text の参照を、link(buildRoute の href)に分割する', () => {
    const tree = apply([{ type: 'paragraph', children: [{ type: 'text', value: 'a src/x.ts:5 b' }] }]);
    const para = tree.children?.[0]?.children ?? [];
    expect(para.map((n) => n.type)).toEqual(['text', 'link', 'text']);
    expect(para[1]?.url).toBe('#/report/reports%2Fa.md?src=src%2Fx.ts&line=5');
    expect(para[1]?.children?.[0]?.value).toBe('src/x.ts:5');
  });
  it('S1-7: href は URL エンコードされ、文書由来の文字が素のまま入らない', () => {
    const tree = apply([{ type: 'paragraph', children: [{ type: 'text', value: 'a/b+c@d.ts:1' }] }]);
    const link = tree.children?.[0]?.children?.[0];
    expect(link?.url).toBe('#/report/reports%2Fa.md?src=a%2Fb%2Bc%40d.ts&line=1');
  });
  it('S1-8: 参照のない text は変わらない', () => {
    const tree = apply([{ type: 'paragraph', children: [{ type: 'text', value: 'foo.ts:0 と 12:30' }] }]);
    expect(tree.children?.[0]?.children).toEqual([{ type: 'text', value: 'foo.ts:0 と 12:30' }]);
  });
  it('S1-8: インラインコード全体が参照なら、link で包む', () => {
    const tree = apply([{ type: 'paragraph', children: [{ type: 'inlineCode', value: 'src/x.ts:5' }] }]);
    const link = tree.children?.[0]?.children?.[0];
    expect(link?.type).toBe('link');
    expect(link?.children?.[0]).toEqual({ type: 'inlineCode', value: 'src/x.ts:5' });
  });
  it('S1-8: インラインコードの一部だけが参照のときは変換しない', () => {
    const tree = apply([{ type: 'paragraph', children: [{ type: 'inlineCode', value: 'cat src/x.ts:5' }] }]);
    expect(tree.children?.[0]?.children?.[0]?.type).toBe('inlineCode');
  });
  it('S1-8: コードブロックと既存のリンクの中は変換しない', () => {
    const code: Node = { type: 'code', value: 'src/x.ts:5' };
    const existing: Node = { type: 'link', url: 'https://e.com', children: [{ type: 'text', value: 'src/x.ts:5' }] };
    const tree = apply([code, { type: 'paragraph', children: [existing] }]);
    expect(tree.children?.[0]).toEqual({ type: 'code', value: 'src/x.ts:5' });
    expect(tree.children?.[1]?.children?.[0]?.children).toEqual([{ type: 'text', value: 'src/x.ts:5' }]);
  });
  it('S1-8: 入れ子(リスト・表)の中の text も変換する', () => {
    const tree = apply([
      { type: 'list', children: [{ type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'src/x.ts:5' }] }] }] },
    ]);
    const inner = tree.children?.[0]?.children?.[0]?.children?.[0]?.children?.[0];
    expect(inner?.type).toBe('link');
  });
  it('S1-8: レポートが無いとき(null)は、ソースだけのリンクになる', () => {
    const tree = apply([{ type: 'paragraph', children: [{ type: 'text', value: 'src/x.ts:5' }] }], null);
    expect(tree.children?.[0]?.children?.[0]?.url).toBe('#/?src=src%2Fx.ts&line=5');
  });
});
