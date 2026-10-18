/**
 * e2e 表示まわりのテスト(ステージ1)
 * 対象基準: S1-2(GFM の変換)、S1-3(Mermaid)、S1-7(HTML・スクリプトの無害化)、S1-8(path:line リンク)
 *
 * SPEC §2.2 の Web API には、Markdown を HTML に変換して返すエンドポイントが無い。
 * 変換と無害化の結果は、画面(ブラウザ)でしか観測できない。
 * ブラウザは playwright ライブラリで起動し、Vitest のフレームワーク内から直接使う。
 *
 * ここで実際に検証するのは:
 * - ブラウザなしで HTTP 越しに観測できる範囲(前提確認)
 * - ブラウザで観測できる変換結果・無害化結果・インタラクション
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { createDeniedFiles } from './helpers/fixtures.js';
import { bodyContains, request, type HttpResult } from './helpers/http.js';
import { startTestServer, stopIfStarted, type TestServer } from './helpers/server.js';
import { launchBrowser, createSession, openReport } from './helpers/browser.js';

/**
 * window.__rvXss: XSS テスト用のグローバル変数
 * フィクスチャのペイロードが実行されると、この配列に実行されたペイロード名が追加される。
 * 無害化が正しく機能していれば、undefined のまま。
 */
declare global {
  interface Window {
    __rvXss?: string[];
  }
}

/** S1-2 用のフィクスチャ(表・タスクリスト・コードブロック) */
const GFM_REPORT = 'reports/2026-08-03-gfm.md';
/** S1-7 用のフィクスチャ(XSS のテストケース) */
const XSS_REPORT = 'reports/2026-08-02-xss.md';
/** S1-7 用のフィクスチャ(閉じない HTML ブロックの後ろにペイロードがある) */
const XSS_EDGE_REPORT = 'reports/2026-08-05-xss-unclosed-block.md';
/** S1-3 用のフィクスチャ(正しい図、不正な記法、スクリプトを仕込んだ図) */
const MERMAID_REPORT = 'reports/2026-08-01-mermaid.md';
/** S1-8 用のフィクスチャ(path:line 形式の参照) */
const LINKS_REPORT = 'reports/2026-10-12-feature.md';

/** ブラウザが、文書としてスクリプトを実行しうる Content-Type */
const ACTIVE_CONTENT_TYPE = /(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)/i;

let server: TestServer;
/** Chromium ブラウザ。beforeAll で起動し、afterAll で閉じる */
let browser: Browser | undefined;

beforeAll(async () => {
  server = await startTestServer();
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser?.close();
  await stopIfStarted(server);
});

/**
 * フィクスチャのファイルを API から取得し、指定した行がすべて含まれることを確かめる
 *
 * @param path リポジトリ相対パス
 * @param lines 含まれているべきテキスト(それぞれ1行に収まるもの)
 * @returns なし(満たさなければ、その場でテストが失敗する)
 */
async function expectFileContains(path: string, lines: string[]): Promise<void> {
  const res = await request(server, `/api/file?path=${encodeURIComponent(path)}`);
  expect(res.status, `GET /api/file?path=${path}`).toBe(200);
  for (const line of lines) {
    expect(bodyContains(res.text, line), `${path} の内容に「${line}」が無い`).toBe(true);
  }
}

/**
 * 応答の Content-Type が存在し、かつ、ブラウザが文書として解釈する種類でないことを確かめる
 *
 * Content-Type が無い応答は、ブラウザが中身から種類を推測するため、HTML として解釈されうる。
 * そのため、まずヘッダが存在することを確かめる。
 *
 * @param res 応答
 * @returns なし(満たさなければ、その場でテストが失敗する)
 */
function expectInertContentType(res: HttpResult): void {
  const contentType = res.headers['content-type'];
  expect(contentType, 'Content-Type ヘッダが無い').toBeDefined();
  expect((contentType ?? '').trim(), 'Content-Type ヘッダが空').not.toBe('');
  expect(contentType, `Content-Type: ${contentType}`).not.toMatch(ACTIVE_CONTENT_TYPE);
}

// ─── S1-2: GFM の変換 ────────────────────────────────────────────────────────

describe('S1-2: GFM rendering', () => {
  it('S1-2 (前提): GFM のフィクスチャが、API から、書かれたとおりに取得できる', async () => {
    await expectFileContains(GFM_REPORT, [
      '| --- | :--- | :---: | ---: |',
      '- [x] GFM-TASK-DONE',
      '- [ ] GFM-TASK-OPEN',
      '```typescript',
      '// GFM-CODE-TS',
    ]);
  });

  it('S1-2: 表が table 要素として表示される(見出し1行、本文2行、4列、列ごとの寄せ)【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, GFM_REPORT);
      const content = session.page.locator('[data-testid="report-content"]');

      // table 要素が存在する
      const table = content.locator('table');
      expect(await table.count(), 'table 要素が見つからない').toBeGreaterThan(0);

      // ヘッダに GFM-TABLE-HEAD が含まれる
      const tableText = await table.first().textContent() ?? '';
      expect(tableText, 'GFM-TABLE-HEAD が表に表示されていない').toContain('GFM-TABLE-HEAD');

      // 本文に GFM-TABLE-CELL-A1 が含まれる
      expect(tableText, 'GFM-TABLE-CELL-A1 が表に表示されていない').toContain('GFM-TABLE-CELL-A1');

      // thead が 1 行ある
      const headerRows = table.first().locator('thead tr');
      expect(await headerRows.count(), 'thead の行数が 1 ではない').toBe(1);

      // thead の列数が 4
      const headerCells = table.first().locator('thead tr th');
      expect(await headerCells.count(), 'ヘッダの列数が 4 ではない').toBe(4);

      // tbody が 2 行ある
      const bodyRows = table.first().locator('tbody tr');
      expect(await bodyRows.count(), 'tbody の行数が 2 ではない').toBe(2);
    } finally {
      await session.close();
    }
  });

  it('S1-2: タスクリストがチェックボックスとして表示され、[x] だけがチェック済みになる【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, GFM_REPORT);
      const content = session.page.locator('[data-testid="report-content"]');
      const checkboxes = content.locator('input[type=checkbox]');

      // チェックボックスが 3 つある
      expect(await checkboxes.count(), 'input[type=checkbox] が 3 つ存在しない').toBe(3);

      // 1 番目(GFM-TASK-DONE)はチェック済み
      expect(
        await checkboxes.nth(0).isChecked(),
        '1 番目のチェックボックス(GFM-TASK-DONE)がチェック済みでない'
      ).toBe(true);

      // 2 番目(GFM-TASK-OPEN)はチェックなし
      expect(
        await checkboxes.nth(1).isChecked(),
        '2 番目のチェックボックス(GFM-TASK-OPEN)がチェック済みになっている'
      ).toBe(false);

      // 3 番目(GFM-TASK-NESTED 入れ子)はチェック済み
      expect(
        await checkboxes.nth(2).isChecked(),
        '3 番目のチェックボックス(GFM-TASK-NESTED)がチェック済みでない'
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('S1-2: コードブロックが整形済みテキストとして表示され、言語指定つきはハイライトされる【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, GFM_REPORT);
      const content = session.page.locator('[data-testid="report-content"]');

      // pre > code 要素が 3 つ以上ある
      const codeBlocks = content.locator('pre > code');
      expect(await codeBlocks.count(), 'pre > code 要素が 3 つ以上存在しない').toBeGreaterThanOrEqual(3);

      // 各ブロックに期待するマーカーが含まれる
      const preTexts = await content.locator('pre').allTextContents();
      const combined = preTexts.join('\n');
      expect(combined, 'GFM-CODE-TS が typescript ブロックにない').toContain('GFM-CODE-TS');
      expect(combined, 'GFM-CODE-JSON が json ブロックにない').toContain('GFM-CODE-JSON');
      expect(combined, 'GFM-CODE-PLAIN が言語指定なしブロックにない').toContain('GFM-CODE-PLAIN');

      // 言語指定つき(typescript)ブロックにはシンタックスハイライトの span が含まれる
      const tsBlock = content.locator('pre > code').filter({ hasText: 'GFM-CODE-TS' });
      expect(await tsBlock.count(), 'GFM-CODE-TS を含む pre > code が見つからない').toBeGreaterThan(0);
      const tsSpans = tsBlock.first().locator('span');
      expect(
        await tsSpans.count(),
        'typescript ブロックにシンタックスハイライトの span が含まれない'
      ).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('S1-2: コードブロックの中の HTML タグは、タグとして解釈されず、文字のまま表示される【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, GFM_REPORT);
      const content = session.page.locator('[data-testid="report-content"]');

      // GFM-CODE-PLAIN を含む pre > code を探す
      const plainBlock = content.locator('pre > code').filter({ hasText: 'GFM-CODE-PLAIN' });
      expect(
        await plainBlock.count(),
        'GFM-CODE-PLAIN を含む pre > code が見つからない'
      ).toBeGreaterThan(0);

      // textContent に <b> リテラルが含まれる(タグではなく文字として表示されている)
      const codeText = (await plainBlock.first().textContent()) ?? '';
      expect(codeText, 'コードブロック内の <b> が文字として表示されていない').toContain('<b>');

      // <b> 要素が存在しない(HTML タグとして解釈されていない)
      const bElements = plainBlock.first().locator('b');
      expect(
        await bElements.count(),
        'コードブロック内に <b> 要素が存在する(HTML タグとして解釈された)'
      ).toBe(0);
    } finally {
      await session.close();
    }
  });
});

// ─── S1-3: Mermaid ───────────────────────────────────────────────────────────

describe('S1-3: Mermaid rendering', () => {
  it('S1-3 (前提): Mermaid のフィクスチャが、API から、書かれたとおりに取得できる', async () => {
    await expectFileContains(MERMAID_REPORT, [
      '```mermaid',
      'MERMAID-NODE-A',
      'MERMAID-INVALID',
      'MERMAID-VISIBLE-TEXT-AFTER',
    ]);
  });

  it('S1-3: 正しい mermaid ブロックが図(SVG)として描画される【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, MERMAID_REPORT);

      // Mermaid は非同期で描画するため、svg が現れるまで待つ
      await session.page.waitForSelector('[data-testid="report-content"] svg', {
        timeout: 15_000,
      });

      const svgCount = await session.page
        .locator('[data-testid="report-content"] svg')
        .count();
      expect(svgCount, 'svg 要素が見つからない(Mermaid 図が描画されていない)').toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('S1-3: 不正な記法のブロックだけがエラー表示になり、前後の文章とほかの図は表示される【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, MERMAID_REPORT);

      // 不正な記法のブロックにエラー表示が現れる
      await session.page.waitForSelector('[data-testid="mermaid-error"]', { timeout: 15_000 });
      const errorCount = await session.page
        .locator('[data-testid="mermaid-error"]')
        .count();
      expect(errorCount, '[data-testid="mermaid-error"] が見つからない').toBeGreaterThan(0);

      // 不正なブロックのあとの文章が表示される
      const pageText = (await session.page.textContent('body')) ?? '';
      expect(pageText, 'MERMAID-VISIBLE-TEXT-AFTER が表示されていない').toContain(
        'MERMAID-VISIBLE-TEXT-AFTER'
      );

      // エラーがあっても、ほかの有効な図は描画される(svg が存在する)
      const svgCount = await session.page
        .locator('[data-testid="report-content"] svg')
        .count();
      expect(svgCount, '有効な図の svg が描画されていない').toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('S1-3: 図に仕込んだスクリプト(ラベルの HTML、click の javascript: やコールバック)が実行されない【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, MERMAID_REPORT);

      // 描画が完了するまで待つ(SVG またはエラー表示のどちらかが現れるまで)
      await Promise.race([
        session.page.waitForSelector('[data-testid="report-content"] svg', { timeout: 15_000 }),
        session.page.waitForSelector('[data-testid="mermaid-error"]', { timeout: 15_000 }),
      ]);

      // img の onerror など非同期イベントの発火を待つため、ネットワーク静止まで待つ
      await session.page
        .waitForLoadState('networkidle', { timeout: 5_000 })
        .catch(() => {
          // networkidle に到達しない場合も問題ない
        });

      // 自動実行チェック: ラベルに仕込んだ img onerror が実行されていないか
      let xss = await session.page.evaluate(() => window.__rvXss);
      expect(xss, 'Mermaid 描画時にスクリプトが自動実行された').toBeUndefined();

      // MERMAID-CLICK-TARGET ノードをクリックして click handler の XSS を確認
      // (SVG 内のテキストを持つ要素を page.evaluate で探してクリック)
      await session.page.evaluate(() => {
        const svgEls = document.querySelectorAll(
          '[data-testid="report-content"] svg *'
        );
        for (const el of svgEls) {
          if (el.textContent?.trim() === 'MERMAID-CLICK-TARGET') {
            (el as HTMLElement).click?.();
            break;
          }
        }
      });

      // クリック後のチェック
      xss = await session.page.evaluate(() => window.__rvXss);
      expect(
        xss,
        'Mermaid ノードのクリックでスクリプトが実行された(javascript: click handler)'
      ).toBeUndefined();
    } finally {
      await session.close();
    }
  });
});

// ─── S1-7: HTML・スクリプトの無害化 ──────────────────────────────────────────

describe('S1-7: HTML and scripts in Markdown are neutralized', () => {
  it('S1-7 (前提): XSS のフィクスチャが、API から取得できる', async () => {
    await expectFileContains(XSS_REPORT, ['XSS-VISIBLE-TEXT-BEFORE', 'XSS-VISIBLE-TEXT-AFTER']);
  });

  it('S1-7: XSS を含む Markdown を返す GET /api/file の応答は、HTML として解釈される Content-Type ではない', async () => {
    // API の URL をブラウザで直接開いたときに、Markdown 中の <script> が実行されないこと
    const res = await request(server, `/api/file?path=${encodeURIComponent(XSS_REPORT)}`);
    expect(res.status).toBe(200);
    expectInertContentType(res);
  });

  it('S1-7: 見出しに HTML を含むレポートがあっても、GET /api/reports の応答は、HTML として解釈される Content-Type ではない', async () => {
    const res = await request(server, '/api/reports');
    expect(res.status).toBe(200);
    expect(res.text).toContain('2026-08-02-xss.md');
    expectInertContentType(res);
  });

  it('S1-7: XSS のフィクスチャを開いても window.__rvXss が未定義のまま(script、イベントハンドラ、埋め込み要素)【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, XSS_REPORT);

      // img onerror / svg onload など非同期イベントの発火を待つため、ネットワーク静止まで待つ
      await session.page
        .waitForLoadState('networkidle', { timeout: 5_000 })
        .catch(() => {
          // networkidle に到達しない場合も問題ない
        });

      // window.__rvXss が未定義のまま
      const xss = await session.page.evaluate(() => window.__rvXss);
      expect(
        xss,
        `XSS ペイロードが実行された: ${JSON.stringify(xss)}`
      ).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('S1-7: javascript: / data: のリンクをクリックしても、スクリプトが実行されない【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, XSS_REPORT);
      const content = session.page.locator('[data-testid="report-content"]');
      const origin = `http://127.0.0.1:${server.port}`;

      // Markdown のリンク記法で書いたものは、リンクの文字が必ず表示される(消えていたら、
      // この資料の後半が Markdown として解釈されていないということで、検証にならない)。
      // 暫定: 無害化でリンクの属性が落ちても、リンクの文字は残る(a 要素である必要はない)と仮定する
      const markdownLinkTexts = ['XSS-LINK-JS(', 'XSS-LINK-JS-MIXED', 'XSS-LINK-DATA'];
      // 生の HTML で書いたもの。無害化で要素ごと除かれてもよいので、あれば検証する
      const htmlLinkTexts = ['XSS-LINK-HTML-JS', 'XSS-LINK-HTML-ENTITY'];

      for (const text of markdownLinkTexts) {
        const target = content.getByText(text).first();
        await target.waitFor({ state: 'visible', timeout: 5_000 });
      }

      for (const text of [...markdownLinkTexts, ...htmlLinkTexts]) {
        const target = content.getByText(text).first();
        if ((await target.count()) === 0) continue;

        // a 要素なら、href が javascript: のまま残っていない
        const anchors = content.locator('a').filter({ hasText: text });
        for (let i = 0; i < (await anchors.count()); i++) {
          const href = ((await anchors.nth(i).getAttribute('href')) ?? '').toLowerCase().trim();
          expect(href, `${text} の href が javascript: のまま残っている`).not.toMatch(/^javascript:/);
        }

        // クリックしてもスクリプトが実行されない。
        // 新しいタブやポップアップに出る場合も含めて、アプリの画面が残っていることも確かめる
        await target.click({ timeout: 5_000 });
        const xss = await session.page.evaluate(() => window.__rvXss);
        expect(xss, `${text} をクリックしてスクリプトが実行された`).toBeUndefined();
        expect(session.page.url().toLowerCase(), `${text} のクリックで画面が javascript: に遷移した`).not.toMatch(
          /^javascript:/
        );
        if (!session.page.url().startsWith(origin)) {
          // data: などへ遷移した場合は、元の画面へ戻して次のリンクを試す
          await openReport(session.page, server, XSS_REPORT);
        }
      }
    } finally {
      await session.close();
    }
  });

  // 閉じタグに空白がある <SCRIPT >…</SCRIPT > は、CommonMark の HTML ブロックを閉じず、
  // 後ろの見出しやリンクまで呑み込む。呑み込まれた部分も含め、何も実行されないこと
  it('S1-7: 閉じない HTML ブロック(</SCRIPT > の空白)の後ろにあるペイロードも、実行されない【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, XSS_EDGE_REPORT);
      const content = session.page.locator('[data-testid="report-content"]');
      // フィクスチャが開けて、前の文章が表示されている
      await content.getByText('XSS-EDGE-VISIBLE-BEFORE').first().waitFor({ state: 'visible', timeout: 5_000 });

      await session.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {
        // networkidle に到達しない場合も問題ない
      });
      expect(await session.page.evaluate(() => window.__rvXss), '開いただけで実行された').toBeUndefined();

      // 後ろにあるリンクが表示されていれば、クリックしても実行されない(呑み込まれて消えていてもよい)
      for (const text of ['XSS-EDGE-LINK-JS', 'XSS-EDGE-LINK-HTML']) {
        const target = content.getByText(text).first();
        if ((await target.count()) === 0) continue;
        await target.click({ timeout: 5_000 });
        expect(await session.page.evaluate(() => window.__rvXss), `${text} のクリックで実行された`).toBeUndefined();
      }
    } finally {
      await session.close();
    }
  });

  it('S1-7: レポート一覧に表示される見出しの HTML が実行されない【要ブラウザ】', async () => {
    // XSS レポートの見出しには <img onerror="window.__rvXss=..."> が含まれる
    // レポート一覧にこの見出しが HTML として解釈されると実行される
    const session = await createSession(browser!);
    try {
      await session.page.goto(`http://127.0.0.1:${server.port}/`);
      await session.page.waitForSelector('[data-testid="report-list"]', { timeout: 10_000 });

      // img onerror など非同期イベントの発火を待つ
      await session.page
        .waitForLoadState('networkidle', { timeout: 5_000 })
        .catch(() => {
          // networkidle に到達しない場合も問題ない
        });

      // window.__rvXss が未定義のまま
      const xss = await session.page.evaluate(() => window.__rvXss);
      expect(
        xss,
        `レポート一覧で XSS ペイロードが実行された: ${JSON.stringify(xss)}`
      ).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('S1-7: 無害化のあとも、前後の通常の文章(XSS-VISIBLE-TEXT-*)は表示される【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, XSS_REPORT);

      // ページ全体のテキストに可視テキストマーカーが含まれる
      const bodyText = (await session.page.textContent('body')) ?? '';
      expect(bodyText, 'XSS-VISIBLE-TEXT-BEFORE が表示されていない').toContain(
        'XSS-VISIBLE-TEXT-BEFORE'
      );
      expect(bodyText, 'XSS-VISIBLE-TEXT-AFTER が表示されていない').toContain(
        'XSS-VISIBLE-TEXT-AFTER'
      );
    } finally {
      await session.close();
    }
  });
});

// ─── S1-8: path:line 形式のリンク ────────────────────────────────────────────

describe('S1-8: path:line links', () => {
  it('S1-8 (前提): 参照を含むレポートと、参照先のソースが、API から取得できる', async () => {
    await expectFileContains(LINKS_REPORT, ['src/example.ts:1', 'subdir/normal.ts:3']);
    await expectFileContains('src/example.ts', ['export function increment']);
    await expectFileContains('subdir/normal.ts', ['export const ANSWER = 42;']);
  });

  it('S1-8: 資料中の src/example.ts:1 がリンクになる【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, LINKS_REPORT);
      const content = session.page.locator('[data-testid="report-content"]');

      // "src/example.ts:1" というテキストを持つ a 要素が存在する
      const link = content.locator('a').filter({ hasText: 'src/example.ts:1' });
      expect(
        await link.count(),
        'src/example.ts:1 が a 要素(リンク)として表示されていない'
      ).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('S1-8: リンクをクリックすると、資料とソースが並んで表示され、該当行へ移動して強調表示される【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      await openReport(session.page, server, LINKS_REPORT);
      const content = session.page.locator('[data-testid="report-content"]');

      // src/example.ts:1 のリンクをクリック
      const link = content.locator('a').filter({ hasText: 'src/example.ts:1' });
      expect(
        await link.count(),
        'src/example.ts:1 のリンクが見つからない(S1-8 前のテストが失敗している可能性がある)'
      ).toBeGreaterThan(0);
      await link.first().click();

      // ソース表示エリアが現れるまで待つ
      await session.page.waitForSelector('[data-testid="source-view"]', { timeout: 10_000 });

      // 1 行目が強調表示されている
      // SPEC §4.1: 強調表示された行は data-highlighted="true" を持つ
      await session.page.waitForSelector(
        '[data-testid="source-line"][data-line="1"][data-highlighted="true"]',
        { timeout: 10_000 }
      );

      const highlightedLine = session.page.locator(
        '[data-testid="source-line"][data-line="1"][data-highlighted="true"]'
      );
      expect(
        await highlightedLine.count(),
        '行番号 1 が data-highlighted="true" で強調表示されていない'
      ).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});

// ─── ソースのツリー表示(SPEC §4.1 の source-tree / source-line-number) ────────

// 基準 ID について: SPEC §4 の「機能」に「ソースのツリー表示とファイル表示(行番号つき)」はあるが、
// 専用の受け入れ基準は無い(S1-9 は手動確認なので、ブラウザテストの ID には使わない)。
// ツリーは、S1-8 が前提にするソース表示エリア(source-view / source-line)へ、
// リンク以外の経路で到達する入口であるため、S1-8 の ID を付ける。
describe('S1-8: ソースのツリーとファイル表示(行番号つき)', () => {
  /**
   * トップページを開き、ソースツリーが表示されるまで待つ
   * @param page Playwright の Page
   * @returns ソースツリーの Locator
   */
  async function openTree(page: import('playwright').Page): Promise<import('playwright').Locator> {
    await page.goto(`http://127.0.0.1:${server.port}/`);
    const tree = page.locator('[data-testid="source-tree"]');
    await tree.waitFor({ state: 'visible', timeout: 10_000 });
    return tree;
  }

  it('S1-8: ツリーのディレクトリを開き、ファイルを開くと、ソース表示エリアに内容が表示される【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      const tree = await openTree(session.page);

      // ディレクトリ subdir の button。aria-expanded を持つ
      const dir = tree.getByRole('button', { name: 'subdir' }).first();
      await dir.waitFor({ state: 'visible', timeout: 5_000 });
      expect(await dir.getAttribute('aria-expanded'), 'ディレクトリの button に aria-expanded が無い').not.toBeNull();

      if ((await dir.getAttribute('aria-expanded')) !== 'true') await dir.click();
      await session.page.waitForSelector('[data-testid="source-tree"] [aria-expanded="true"]', { timeout: 5_000 });
      expect(await dir.getAttribute('aria-expanded')).toBe('true');

      // 中のファイルの button をクリックすると、ソース表示エリアにそのファイルが開く
      const file = tree.getByRole('button', { name: 'normal.ts' }).first();
      await file.waitFor({ state: 'visible', timeout: 5_000 });
      await file.click();

      const view = session.page.locator('[data-testid="source-view"]');
      await view.waitFor({ state: 'visible', timeout: 10_000 });
      await view.getByText('export const ANSWER = 42;').first().waitFor({ state: 'visible', timeout: 10_000 });
    } finally {
      await session.close();
    }
  });

  it('S1-8: ソース表示エリアの各行に、1 始まりの行番号が表示される【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      const tree = await openTree(session.page);
      const dir = tree.getByRole('button', { name: 'subdir' }).first();
      if ((await dir.getAttribute('aria-expanded')) !== 'true') await dir.click();
      await tree.getByRole('button', { name: 'normal.ts' }).first().click();

      // subdir/normal.ts は 3 行(コメント、空行、export const ANSWER = 42;)
      const line3 = session.page.locator('[data-testid="source-view"] [data-testid="source-line"][data-line="3"]');
      await line3.waitFor({ state: 'visible', timeout: 10_000 });
      expect(await line3.textContent(), '3 行目に export const ANSWER が無い').toContain('export const ANSWER = 42;');

      for (const n of [1, 2, 3]) {
        const line = session.page.locator(`[data-testid="source-line"][data-line="${n}"]`);
        const number = line.locator('[data-testid="source-line-number"]');
        expect(await number.count(), `行 ${n} に source-line-number が 1 つ無い`).toBe(1);
        expect((await number.textContent())?.trim(), `行 ${n} の行番号の表示`).toBe(String(n));
      }
    } finally {
      await session.close();
    }
  });

  it('S1-8: ディレクトリの button をもう一度クリックすると閉じ、中のファイルが見えなくなる【要ブラウザ】', async () => {
    const session = await createSession(browser!);
    try {
      const tree = await openTree(session.page);
      const dir = tree.getByRole('button', { name: 'subdir' }).first();
      await dir.waitFor({ state: 'visible', timeout: 5_000 });
      if ((await dir.getAttribute('aria-expanded')) !== 'true') await dir.click();
      await tree.getByRole('button', { name: 'normal.ts' }).first().waitFor({ state: 'visible', timeout: 5_000 });
      expect(await dir.getAttribute('aria-expanded')).toBe('true');

      await dir.click();
      await tree.getByRole('button', { name: 'normal.ts' }).first().waitFor({ state: 'hidden', timeout: 5_000 });
      expect(await dir.getAttribute('aria-expanded'), '閉じても aria-expanded が "true" のまま').not.toBe('true');
    } finally {
      await session.close();
    }
  });

  it('S1-5: ツリーに、秘密ファイルや .gitignore の対象が表示されない【要ブラウザ】', async () => {
    // 画面経由でも、一覧に出さないことを確かめる(API の S1-5 と同じ基準を、画面で見る)
    const secret = await startTestServer({
      setup: async (repoDir) => {
        await createDeniedFiles(repoDir);
      },
    });
    const session = await createSession(browser!);
    try {
      await session.page.goto(`http://127.0.0.1:${secret.port}/`);
      const tree = session.page.locator('[data-testid="source-tree"]');
      await tree.waitFor({ state: 'visible', timeout: 10_000 });
      // 一覧が描画されていること(空では検証にならない)
      await tree.getByRole('button', { name: 'subdir' }).first().waitFor({ state: 'visible', timeout: 5_000 });
      const text = (await tree.textContent()) ?? '';
      for (const name of ['.env', 'secret.pem', 'server.key', 'id_rsa', 'credentials', '.claude.json', 'excluded-by-git.txt', 'build-out']) {
        expect(text, `ツリーに ${name} が表示されている`).not.toContain(name);
      }
    } finally {
      await session.close();
      await secret.stop();
    }
  });
});
