/**
 * T1-4: ソース表示の単体テスト(S1-8 が前提にする要素の約束 = SPEC §4.1 の確認)
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSource, SourceLines } from './SourceView.js';

describe('SourceLines', () => {
  it('S1-8: 各行が data-testid="source-line" と data-line(1 始まり)を持つ', () => {
    const html = renderToStaticMarkup(<SourceLines lines={['a', 'b']} tokens={null} highlightedLine={null} />);
    expect(html).toContain('data-testid="source-line" data-line="1"');
    expect(html).toContain('data-testid="source-line" data-line="2"');
    expect(html).not.toContain('data-highlighted');
  });

  it('S1-8: 強調する行だけが data-highlighted="true" を持つ', () => {
    const html = renderToStaticMarkup(<SourceLines lines={['a', 'b']} tokens={null} highlightedLine={2} />);
    expect(html).toMatch(/data-line="2" data-highlighted="true"/);
    expect(html.match(/data-highlighted/g)).toHaveLength(1);
  });

  it('S1-8: 行番号が表示される', () => {
    const html = renderToStaticMarkup(<SourceLines lines={['a']} tokens={null} highlightedLine={null} />);
    expect(html).toContain('<span class="line-number" data-testid="source-line-number">1</span>');
  });

  it('S1-7: 行の中身は HTML として解釈されず、エスケープされる', () => {
    const html = renderToStaticMarkup(
      <SourceLines lines={['<img src=x onerror=alert(1)>']} tokens={null} highlightedLine={null} />
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('S1-8: トークンは span として描画される(エスケープされる)', () => {
    const html = renderToStaticMarkup(
      <SourceLines
        lines={['<b>x']}
        tokens={[[{ content: '<b>', offset: 0, color: '#ff0000' }, { content: 'x', offset: 3 }]]}
        highlightedLine={null}
      />
    );
    expect(html).toContain('<span style="color:#ff0000">&lt;b&gt;</span><span>x</span>');
  });
});

describe('loadSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * fetch を、指定した JSON を返すものに差し替える
   *
   * @param body 応答の JSON
   * @param status HTTP ステータス
   */
  function stubFetch(body: unknown, status = 200): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
  }

  it('S1-5: 巨大ファイルは「表示できません」(本文なし)', async () => {
    stubFetch({ kind: 'too_large', path: 'big.txt' });
    expect(await loadSource('big.txt')).toEqual({
      status: 'unreadable',
      message: 'ファイルが大きすぎるため、表示できません',
    });
  });

  it('S1-6: バイナリは「表示できません」', async () => {
    stubFetch({ kind: 'binary', path: 'a.png' });
    expect(await loadSource('a.png')).toEqual({
      status: 'unreadable',
      message: 'バイナリファイルは表示できません',
    });
  });

  it('S1-4: 取得に失敗したら error にする(例外にしない)。メッセージにパスを含めない', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubFetch({ error: 'forbidden' }, 403);
    const state = await loadSource('secret/.env');
    expect(state).toEqual({ status: 'error', message: 'ファイルを開けませんでした' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('S1-8: テキストは行に分けて ready にする(拡張子が不明なら装飾なし)', async () => {
    stubFetch({ kind: 'text', path: 'notes.unknownext', content: 'a\nb\n' });
    const state = await loadSource('notes.unknownext');
    expect(state.status).toBe('ready');
    if (state.status === 'ready') {
      expect(state.lines).toEqual(['a', 'b']);
      expect(state.tokens).toBeNull();
    }
  });
});
