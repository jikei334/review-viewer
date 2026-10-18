/**
 * 単体テスト用の Vitest 設定(npm run test)
 *
 * システムテスト(e2e/)は e2e/vitest.config.ts で別に実行するので、ここでは対象から外す。
 */
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: [...configDefaults.exclude, 'e2e/**', 'dist/**'],
  },
});
