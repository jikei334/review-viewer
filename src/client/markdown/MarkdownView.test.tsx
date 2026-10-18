/**
 * T1-3: Markdown 表示の単体テスト(S1-2: GFM、S1-7: 無害化と XSS のケース)
 *
 * ブラウザを使わず、サーバー側の描画(renderToStaticMarkup)で、出力された HTML の文字列を調べる。
 * 実際のブラウザでの確認は、システムテスト(e2e/render.test.ts)が行う。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CodeHighlighter } from './highlight.js';
import { PLAIN_HIGHLIGHTER } from './highlight.js';
import { MarkdownView } from './MarkdownView.js';

/**
 * Markdown を HTML の文字列に描画する
 *
 * @param source Markdown の本文
 * @param highlighter ハイライタ(省略時は装飾なし)
 * @returns HTML の文字列
 */
function render(source: string, highlighter: CodeHighlighter = PLAIN_HIGHLIGHTER): string {
  return renderToStaticMarkup(<MarkdownView source={source} highlighter={highlighter} />);
}

/** すべてのコードを2つのトークン(色つき)に分ける、テスト用のハイライタ */
const FAKE_HIGHLIGHTER: CodeHighlighter = {
  highlight: (code, lang) =>
    lang === 'typescript'
      ? code.split('\n').map((line, index) => [
          { content: line.slice(0, 2), offset: index, color: '#ff0000' },
          { content: line.slice(2), offset: index + 2 },
        ])
      : null,
};

describe('S1-2: GFM の変換', () => {
  it('S1-2: 表が table 要素になる', () => {
    const html = render('| a | b |\n| --- | :---: |\n| 1 | 2 |\n');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('text-align:center');
  });

  it('S1-2: タスクリストが checkbox になり、[x] だけがチェック済みになる', () => {
    const html = render('- [x] done\n- [ ] open\n');
    const boxes = html.match(/<input[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toContain('type="checkbox"');
    expect(boxes[0]).toContain('checked');
    expect(boxes[1]).not.toContain('checked');
  });

  it('S1-2: コードブロックが pre > code になり、言語のクラスが付く', () => {
    const html = render('```typescript\nconst a = 1;\n```\n');
    expect(html).toContain('<pre><code class="language-typescript">');
  });

  it('S1-2: ハイライトできる言語は span で色が付き、できない言語・言語なしは span なしの pre > code になる', () => {
    const highlighted = render('```typescript\nconst a = 1;\n```\n', FAKE_HIGHLIGHTER);
    expect(highlighted).toMatch(/<pre><code class="language-typescript"><span/);
    expect(highlighted).toContain('color:#ff0000');
    // 全体の文字が、欠けず・重複せずに残る
    expect(highlighted.replace(/<[^>]+>/g, '')).toContain('const a = 1;');

    const plain = render('```\nplain text\n```\n', FAKE_HIGHLIGHTER);
    expect(plain).toContain('<pre><code>plain text</code></pre>');
    const unknown = render('```nolang\nx\n```\n', FAKE_HIGHLIGHTER);
    expect(unknown).toContain('<pre><code class="language-nolang">x</code></pre>');
  });

  it('S1-2: コードブロックの中の HTML タグは、文字(エスケープ)のまま出る', () => {
    const html = render('```\n<b>bold</b>\n```\n');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('S1-3: mermaid ブロックは pre > code にならず、図の描画用の要素になる(記法を HTML として出さない)', () => {
    const html = render('```mermaid\ngraph TD\n  A --> B\n```\n');
    expect(html).not.toContain('<pre>');
    expect(html).toContain('mermaid-loading');
  });
});

describe('S1-7: HTML・スクリプトの無害化(XSS のケース)', () => {
  /** 実行されうる要素・属性・URL を含んでいないことを確かめる */
  function expectInert(rawHtml: string): void {
    // React 19 は、画像の描画で <link rel="preload" as="image"> を出す(React 自身が作るもので、Markdown 由来ではない)
    const html = rawHtml.replace(/<link rel="preload" as="image"[^>]*>/g, '');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<object/i);
    expect(html).not.toMatch(/<embed/i);
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/<meta/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(href|src)="\s*(javascript|vbscript|data):/i);
  }

  const cases: ReadonlyArray<readonly [string, string]> = [
    ['script タグ', '<script>alert(1)</script>\n\ntext'],
    ['大文字の script タグ', '<SCRIPT>alert(1)</SCRIPT>\n\ntext'],
    ['文中の script タグ', '前 <script>alert(1)</script> 後'],
    ['img の onerror', '<img src=x onerror="alert(1)">'],
    ['文中の img の onerror', '前 <img src=x onerror="alert(1)"> 後'],
    ['svg の onload', '<svg onload="alert(1)"></svg>'],
    ['svg の中の script', '<svg><script>alert(1)</script></svg>'],
    ['details の ontoggle', '<details open ontoggle="alert(1)"><summary>s</summary>b</details>'],
    ['div の onmouseover', '<div onmouseover="alert(1)">hover</div>'],
    ['input の onfocus', '<input autofocus onfocus="alert(1)">'],
    ['a の javascript: href', '<a href="javascript:alert(1)">x</a>'],
    ['a の javascript: href(実体参照)', '<a href="&#106;avascript:alert(1)">x</a>'],
    ['iframe の srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['iframe の javascript: src', '<iframe src="javascript:alert(1)"></iframe>'],
    ['object', '<object data="javascript:alert(1)"></object>'],
    ['embed', '<embed src="javascript:alert(1)">'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
    ['form の action', '<form action="javascript:alert(1)"><button>b</button></form>'],
    ['link', '<link rel="stylesheet" href="javascript:alert(1)">'],
    ['style', '<style>body{background:url(javascript:alert(1))}</style>'],
    ['Markdown リンクの javascript:', '[x](javascript:alert(1))'],
    ['Markdown リンクの大文字小文字混じり javascript:', '[x](JaVaScRiPt:alert(1))'],
    ['Markdown リンクの data:', '[x](data:text/html,<script>alert(1)</script>)'],
    ['Markdown 画像の javascript:', '![x](javascript:alert(1))'],
    ['表のセルの img', '| a |\n| --- |\n| <img src=x onerror="alert(1)"> |'],
    ['タスクの中の img', '- [ ] <img src=x onerror="alert(1)"> task'],
    ['参照形式リンクの javascript:', '[x][r]\n\n[r]: javascript:alert(1)'],
  ];

  it.each(cases)('S1-7: %s は要素・属性・URL として残らない', (_name, source) => {
    expectInert(render(source));
  });

  it('S1-7: alt に引用符を含めて属性を増やそうとしても、値の中に閉じ込められる(エスケープされる)', () => {
    const html = render('![x" onerror="alert(1)](a.png)');
    expect(html).toContain('alt="x&quot; onerror=&quot;alert(1)"');
    // alt の値の外に、onerror 属性が出ていない(img タグから alt の値を除いて調べる)
    const tag = /<img[^>]*>/.exec(html)?.[0] ?? '';
    expect(tag.replace(/alt="[^"]*"/, '')).not.toMatch(/onerror/i);
  });

  it('S1-7: 無害化のあとも、前後の通常の文章は表示される', () => {
    const html = render('BEFORE-TEXT\n\n<script>alert(1)</script>\n\nAFTER-TEXT');
    expect(html).toContain('BEFORE-TEXT');
    expect(html).toContain('AFTER-TEXT');
  });

  it('S1-7: 安全なリンク(https)は残り、href が書き換わらない', () => {
    const html = render('[ok](https://example.com/a)');
    expect(html).toContain('<a href="https://example.com/a">ok</a>');
  });

  it('S1-7: コードの中の script は、文字として表示され、要素にならない', () => {
    const html = render('`<script>alert(1)</script>`\n\n```html\n<script>alert(1)</script>\n```');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
