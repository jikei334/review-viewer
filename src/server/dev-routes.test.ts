/**
 * T1-8: 開発サーバーの経路の判定の単体テスト
 */
import { describe, expect, it } from 'vitest';
import { isApiPath } from './dev-routes.js';

describe('T1-8: isApiPath', () => {
  it.each(['/api', '/api/reports', '/api/files?path=a', '/healthz', '/healthz?x=1'])(
    'T1-8: %s は API 側で処理する',
    (url) => {
      expect(isApiPath(url)).toBe(true);
    }
  );

  it.each(['/', '/index.html', '/apix', '/@vite/client', '/src/main.tsx', '/healthzz', undefined])(
    'T1-8: %s は Vite 側で処理する',
    (url) => {
      expect(isApiPath(url)).toBe(false);
    }
  );
});
