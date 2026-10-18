/**
 * e2e システムテスト用の Vitest 設定
 * 単体テスト用の設定とは別に管理する。
 *
 * 想定する呼び出し方(package.json の scripts。Coder が用意する):
 *   "e2e": "vitest run --config e2e/vitest.config.ts"
 * 基準 ID で絞り込める: npm run e2e -- -t S1-4
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // どのディレクトリから実行しても同じ結果になるように、ルートを固定する
    root: resolve(E2E_DIR, '..'),
    include: ['e2e/**/*.test.ts'],
    // テストの前に一度だけ `npm run build` を行う(SPEC §2.5)
    globalSetup: [resolve(E2E_DIR, 'global-setup.ts')],
    // サーバーの起動を含むため、長めのタイムアウトにする
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // 各テストはランダムなポートを使うが、安定のためにファイル単位では直列に実行する
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
