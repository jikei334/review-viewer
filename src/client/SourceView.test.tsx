/**
 * T1-4: ソース表示の単体テスト(S1-8 が前提にする要素の約束 = SPEC §4.1 の確認)
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourceLines } from './SourceView.js';

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
