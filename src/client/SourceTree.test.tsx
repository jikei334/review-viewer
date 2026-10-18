/**
 * T1-5: ソースツリーの単体テスト(展開と取得)
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreeNodes } from './SourceTree.js';
import { loadListing, needsLoad, type Listing } from './tree-state.js';

const noop = (): void => undefined;

/**
 * ツリーを描画する
 *
 * @param listings ディレクトリごとの取得状態
 * @param expanded 展開しているディレクトリ
 * @param selectedPath 選択中のパス
 * @returns HTML の文字列
 */
function render(
  listings: Record<string, Listing>,
  expanded: string[],
  selectedPath: string | null = null
): string {
  return renderToStaticMarkup(
    <TreeNodes
      path=""
      listings={listings}
      expanded={new Set(expanded)}
      selectedPath={selectedPath}
      onToggle={noop}
      onSelectFile={noop}
    />
  );
}

const ROOT: Listing = {
  status: 'ready',
  entries: [
    { name: 'src', path: 'src', type: 'directory' },
    { name: 'a.md', path: 'a.md', type: 'file' },
  ],
};

describe('TreeNodes', () => {
  it('S1-8: 閉じているディレクトリの中身は描画しない', () => {
    const html = render({ '': ROOT }, ['']);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('▸ src');
    expect(html).not.toContain('読み込み中');
  });
  it('S1-8: 開いているディレクトリは、取得済みの中身を入れ子で描画する', () => {
    const src: Listing = { status: 'ready', entries: [{ name: 'x.ts', path: 'src/x.ts', type: 'file' }] };
    const html = render({ '': ROOT, src }, ['', 'src']);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('▾ src');
    expect(html).toContain('x.ts');
  });
  it('S1-8: 取得中は「読み込み中」、失敗は alert、空は「空のディレクトリ」を出す', () => {
    expect(render({ '': ROOT, src: { status: 'loading' } }, ['', 'src'])).toContain('読み込み中');
    expect(render({ '': ROOT, src: { status: 'error' } }, ['', 'src'])).toContain('role="alert"');
    expect(render({ '': ROOT, src: { status: 'ready', entries: [] } }, ['', 'src'])).toContain('空のディレクトリ');
  });
  it('S1-8: 選択中のファイルに aria-current が付く', () => {
    const html = render({ '': ROOT }, [''], 'a.md');
    expect(html).toMatch(/aria-current="true"[^>]*>a\.md/);
  });
  it('S1-7: ファイル名の HTML はエスケープされる', () => {
    const evil: Listing = { status: 'ready', entries: [{ name: '<img src=x>', path: 'e', type: 'file' }] };
    expect(render({ '': evil }, [''])).not.toContain('<img');
  });
});

describe('needsLoad', () => {
  it('S1-8: 未取得と失敗のときだけ取得する', () => {
    expect(needsLoad(undefined)).toBe(true);
    expect(needsLoad({ status: 'error' })).toBe(true);
    expect(needsLoad({ status: 'loading' })).toBe(false);
    expect(needsLoad(ROOT)).toBe(false);
  });
});

describe('loadListing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('S1-8: 一覧を取得して ready にし、パスをクエリに入れる', async () => {
    const fn = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ entries: [{ name: 'x.ts', path: 'src/x.ts', type: 'file' }] })));
    vi.stubGlobal('fetch', fn);
    expect(await loadListing('src')).toEqual({
      status: 'ready',
      entries: [{ name: 'x.ts', path: 'src/x.ts', type: 'file' }],
    });
    expect(String(fn.mock.calls[0]?.[0])).toBe('/api/tree?path=src');
  });
  it('S1-8: 失敗したら error にする(例外にしない)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
    expect(await loadListing('src')).toEqual({ status: 'error' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
