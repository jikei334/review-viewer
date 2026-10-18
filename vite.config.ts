/**
 * Vite の設定(画面のビルドと開発サーバー)
 *
 * 画面のソースは src/client、ビルド成果物は dist/client に置く。
 */
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(ROOT_DIR, 'src/client'),
  plugins: [react()],
  build: {
    outDir: resolve(ROOT_DIR, 'dist/client'),
    emptyOutDir: true,
  },
  server: {
    // 開発サーバーも 127.0.0.1 だけに bind する(CLAUDE.md の絶対ルール2)
    host: '127.0.0.1',
  },
});
