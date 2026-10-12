/**
 * e2e 表示まわりのテスト(ステージ1)
 * 対象基準: S1-2(GFM の変換)、S1-3(Mermaid)、S1-7(HTML・スクリプトの無害化)、S1-8(path:line リンク)
 *
 * SPEC §2.2 の Web API には、Markdown を HTML に変換して返すエンドポイントが無い。
 * 変換と無害化の結果は、画面(ブラウザ)でしか観測できない。
 * ブラウザ自動化ツールは未導入(SPEC §10。導入するかどうかは人間が決める)なので、
 * 画面が必要な検証は `it.todo` として残し、未カバーとして報告する。
 *
 * ここで実際に検証するのは、ブラウザなしで、HTTP 越しに観測できる範囲だけ。
 * - 前提: 確認用のフィクスチャが、API から、書かれたとおりの内容で取得できる
 * - S1-7 の一部: API の応答そのものが、ブラウザに HTML として解釈される形で返らない
 *
 * 「(前提)」と付いたテストが通っても、その基準を満たしたことにはならない。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bodyContains, request, type HttpResult } from './helpers/http.js';
import { startTestServer, stopIfStarted, type TestServer } from './helpers/server.js';

/** S1-2 用のフィクスチャ(表・タスクリスト・コードブロック) */
const GFM_REPORT = 'reports/2026-08-03-gfm.md';
/** S1-7 用のフィクスチャ(XSS のテストケース) */
const XSS_REPORT = 'reports/2026-08-02-xss.md';
/** S1-3 用のフィクスチャ(正しい図、不正な記法、スクリプトを仕込んだ図) */
const MERMAID_REPORT = 'reports/2026-08-01-mermaid.md';
/** S1-8 用のフィクスチャ(path:line 形式の参照) */
const LINKS_REPORT = 'reports/2026-10-12-feature.md';

/** ブラウザが、文書としてスクリプトを実行しうる Content-Type */
const ACTIVE_CONTENT_TYPE = /(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)/i;

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
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

  // 以下は画面(ブラウザ)が必要。ブラウザ自動化ツールが未導入のため未カバー
  it.todo('S1-2: 表が table 要素として表示される(見出し1行、本文2行、4列、列ごとの寄せ)【要ブラウザ】');
  it.todo('S1-2: タスクリストがチェックボックスとして表示され、[x] だけがチェック済みになる【要ブラウザ】');
  it.todo('S1-2: コードブロックが整形済みテキストとして表示され、言語指定つきはハイライトされる【要ブラウザ】');
  it.todo('S1-2: コードブロックの中の HTML タグは、タグとして解釈されず、文字のまま表示される【要ブラウザ】');
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

  // 以下は画面(ブラウザ)が必要。ブラウザ自動化ツールが未導入のため未カバー
  it.todo('S1-3: 正しい mermaid ブロックが図(SVG)として描画される【要ブラウザ】');
  it.todo('S1-3: 不正な記法のブロックだけがエラー表示になり、前後の文章とほかの図は表示される【要ブラウザ】');
  it.todo('S1-3: 図に仕込んだスクリプト(ラベルの HTML、click の javascript: やコールバック)が実行されない【要ブラウザ】');
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

  // 以下は画面(ブラウザ)が必要。ブラウザ自動化ツールが未導入のため未カバー。
  // 判定方法: フィクスチャの各ペイロードは、実行されると window.__rvXss に名前を追加する
  it.todo('S1-7: XSS のフィクスチャを開いても window.__rvXss が未定義のまま(script、イベントハンドラ、埋め込み要素)【要ブラウザ】');
  it.todo('S1-7: javascript: / data: のリンクをクリックしても、スクリプトが実行されない【要ブラウザ】');
  it.todo('S1-7: レポート一覧に表示される見出しの HTML が実行されない【要ブラウザ】');
  it.todo('S1-7: 無害化のあとも、前後の通常の文章(XSS-VISIBLE-TEXT-*)は表示される【要ブラウザ】');
});

// ─── S1-8: path:line 形式のリンク ────────────────────────────────────────────

describe('S1-8: path:line links', () => {
  it('S1-8 (前提): 参照を含むレポートと、参照先のソースが、API から取得できる', async () => {
    await expectFileContains(LINKS_REPORT, ['src/example.ts:1', 'subdir/normal.ts:3']);
    await expectFileContains('src/example.ts', ['export function increment']);
    await expectFileContains('subdir/normal.ts', ['export const ANSWER = 42;']);
  });

  // 以下は画面(ブラウザ)が必要。ブラウザ自動化ツールが未導入のため未カバー
  it.todo('S1-8: 資料中の src/example.ts:1 がリンクになる【要ブラウザ】');
  it.todo('S1-8: リンクをクリックすると、資料とソースが並んで表示され、該当行へ移動して強調表示される【要ブラウザ】');
});
