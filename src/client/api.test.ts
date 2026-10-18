/**
 * T1-3: API クライアントの単体テスト(応答の形の検証)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchFile, fetchReports, fetchTree } from './api.js';

/**
 * fetch を、指定した応答を返すものに差し替える
 *
 * @param body 応答の JSON
 * @param status HTTP ステータス
 * @returns 差し替えた fetch(呼び出しの確認用)
 */
function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchReports', () => {
  it('S1-1: レポート一覧を、サーバーの順序のまま返す', async () => {
    const reports = [
      { name: 'b.md', path: 'reports/b.md', modifiedAt: '2026-02-01T00:00:00.000Z' },
      { name: 'a.md', path: 'reports/a.md', modifiedAt: '2026-01-01T00:00:00.000Z' },
    ];
    stubFetch({ reports });
    expect(await fetchReports()).toEqual(reports);
  });

  it('S1-1: 形が違う応答は ApiError', async () => {
    stubFetch({ reports: [{ name: 1 }] });
    await expect(fetchReports()).rejects.toBeInstanceOf(ApiError);
    stubFetch({ nope: [] });
    await expect(fetchReports()).rejects.toBeInstanceOf(ApiError);
  });

  it('S1-1: 200 以外は ApiError(ステータスを持つ)', async () => {
    stubFetch({ error: 'x' }, 500);
    await expect(fetchReports()).rejects.toMatchObject({ name: 'ApiError', status: 500 });
  });

  it('S1-1: 通信に失敗したら ApiError(原因を cause に持つ)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    await expect(fetchReports()).rejects.toMatchObject({ name: 'ApiError', status: 0 });
  });
});

describe('fetchFile', () => {
  it('S1-2: パスを URL エンコードして要求し、本文を返す', async () => {
    const fn = stubFetch({ path: 'reports/a b.md', size: 3, kind: 'text', content: 'abc' });
    expect(await fetchFile('reports/a b.md')).toEqual({ kind: 'text', path: 'reports/a b.md', content: 'abc' });
    expect(fn.mock.calls[0]?.[0]).toBe('/api/file?path=reports%2Fa%20b.md');
  });

  it('S1-6: 巨大ファイルとバイナリは、本文なしで返す', async () => {
    stubFetch({ path: 'x', size: 9, kind: 'too_large', maxBytes: 1 });
    expect(await fetchFile('x')).toEqual({ kind: 'too_large', path: 'x' });
    stubFetch({ path: 'x', size: 9, kind: 'binary' });
    expect(await fetchFile('x')).toEqual({ kind: 'binary', path: 'x' });
  });

  it('S1-2: 形が違う応答は ApiError', async () => {
    stubFetch({ path: 'x', kind: 'text' });
    await expect(fetchFile('x')).rejects.toBeInstanceOf(ApiError);
    stubFetch({ path: 'x', kind: 'other' });
    await expect(fetchFile('x')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('fetchTree', () => {
  it('S1-8: 一覧を返し、パスを URL エンコードして要求する', async () => {
    const entries = [
      { name: 'src', path: 'src', type: 'directory' },
      { name: 'a b.ts', path: 'a b.ts', type: 'file' },
    ];
    const fn = stubFetch({ path: '', entries });
    expect(await fetchTree('')).toEqual(entries);
    expect(fn.mock.calls[0]?.[0]).toBe('/api/tree?path=');
    const fn2 = stubFetch({ path: 'a b', entries: [] });
    await fetchTree('a b');
    expect(fn2.mock.calls[0]?.[0]).toBe('/api/tree?path=a%20b');
  });
  it('S1-8: 形が違う応答(未知の type など)は ApiError', async () => {
    stubFetch({ entries: [{ name: 'x', path: 'x', type: 'symlink' }] });
    await expect(fetchTree('')).rejects.toBeInstanceOf(ApiError);
    stubFetch({});
    await expect(fetchTree('')).rejects.toBeInstanceOf(ApiError);
  });
});
