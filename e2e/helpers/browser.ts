/**
 * e2e テスト用ブラウザヘルパー
 *
 * Playwright ライブラリ(@playwright/test ではなく playwright)を使って
 * ブラウザの起動・後始末と、レポートを開くヘルパーを提供する。
 * e2e/ 内の他のファイルから使いまわせる。
 *
 * 注意: ブラウザが未インストールの場合は Playwright が例外を投げる。
 * エラーメッセージに `npx playwright install --with-deps chromium` の手順が含まれる。
 */

import { basename, extname } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { TestServer } from './server.js';

export type { Browser, BrowserContext, Page };

/**
 * Chromium ブラウザを起動する
 *
 * ブラウザが未インストールの場合は Playwright が例外を投げる。
 * スキップや握りつぶしはしないこと。エラーを見た人が
 * `npx playwright install --with-deps chromium` を実行できるようにする。
 *
 * @returns 起動済みの Browser インスタンス
 */
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch();
}

/** ブラウザセッション(コンテキスト + ページ + 後始末) */
export interface BrowserSession {
  /** ブラウザコンテキスト(テストごとに独立した状態を持つ) */
  context: BrowserContext;
  /** ページ */
  page: Page;
  /**
   * コンテキストを閉じる。成否に関わらず finally ブロックで必ず呼ぶこと
   * @returns なし
   */
  close: () => Promise<void>;
}

/**
 * ブラウザコンテキストとページを作成する
 *
 * テストごとに独立したコンテキストを作ることで、window.__rvXss などの
 * グローバル状態が他のテストに影響しないようにする。
 *
 * @param browser 起動済みの Browser
 * @returns セッション(コンテキスト、ページ、後始末関数)
 */
export async function createSession(browser: Browser): Promise<BrowserSession> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    context,
    page,
    close: async () => {
      await context.close();
    },
  };
}

/**
 * テストサーバーのトップページを開いてレポートを選択し、レポート内容が表示されるまで待つ
 *
 * SPEC §4.1 の画面の契約に従い、以下の順序で操作する:
 * 1. `GET /` を開く
 * 2. `[data-testid="report-list"]` の `a` 要素からレポートのリンクを探してクリック
 * 3. `[data-testid="report-content"]` が現れるまで待つ
 *
 * リンクの特定は、href またはテキストにレポートのベース名(拡張子なし)が含まれるものを使う。
 * 実装側の URL 設計に依存しないよう、複数の方法で順に試みる。
 *
 * @param page Playwright の Page
 * @param server 起動済みテストサーバー
 * @param reportPath リポジトリ相対パス (例: "reports/2026-08-03-gfm.md")
 * @returns なし(要素が見つからなければ waitForSelector がタイムアウトエラーを投げる)
 */
export async function openReport(
  page: Page,
  server: TestServer,
  reportPath: string
): Promise<void> {
  // "reports/2026-08-03-gfm.md" → "2026-08-03-gfm"
  const name = basename(reportPath, extname(reportPath));

  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForSelector('[data-testid="report-list"]', { timeout: 10_000 });

  let clicked = false;

  // 1. href にベース名が含まれるリンクを探す
  if (!clicked) {
    const byHref = page.locator(`[data-testid="report-list"] a[href*="${name}"]`);
    if ((await byHref.count()) > 0) {
      await byHref.first().click();
      clicked = true;
    }
  }

  // 2. href にリポジトリ相対パスが含まれるリンクを探す
  if (!clicked) {
    const byFullPath = page.locator(`[data-testid="report-list"] a[href*="${reportPath}"]`);
    if ((await byFullPath.count()) > 0) {
      await byFullPath.first().click();
      clicked = true;
    }
  }

  // 3. テキスト(innerText)にベース名が含まれるリンクを探す
  if (!clicked) {
    const byText = page.locator('[data-testid="report-list"] a').filter({ hasText: name });
    if ((await byText.count()) > 0) {
      await byText.first().click();
      clicked = true;
    }
  }

  if (!clicked) {
    throw new Error(
      `[data-testid="report-list"] 内に "${name}" に関連するリンクが見つかりません。` +
        `実装されていないか、レポートが一覧に表示されていない可能性があります。`
    );
  }

  await page.waitForSelector('[data-testid="report-content"]', { timeout: 15_000 });
}
