// ESLint の設定(flat config)。TypeScript は typescript-eslint の recommended を使う
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // 生成物と、e2e のテストデータ(フィクスチャのリポジトリ)は対象外
  globalIgnores(['dist/', 'coverage/', 'node_modules/', 'e2e/fixtures/', 'e2e/.tmp/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // e2e/ は Tester の持ち物で、Coder は編集できない(CLAUDE.md の絶対ルール13)。
    // e2e/global-setup.ts が、捕まえたエラーを `cause` ではなくメッセージ文字列に含めて
    // 投げ直しているため、ESLint 10 の recommended に入った preserve-caught-error に掛かる。
    // 元のエラーの内容はメッセージに残っているので、e2e/ に限ってこのルールだけを外す。
    // src/ には適用したままにする
    files: ['e2e/**/*.ts'],
    rules: {
      'preserve-caught-error': 'off',
    },
  },
]);
