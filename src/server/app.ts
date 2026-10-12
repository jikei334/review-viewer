/**
 * Hono アプリの組み立て
 *
 * ここは薄いアダプタ。検証の規則は request-guard.ts(純粋関数)に置く。
 * 起動やシグナル処理などの副作用は持たない(テストから import して使えるようにする)。
 */
import { Hono } from 'hono';
import type { ServerConfig } from './config.js';
import { checkRequest } from './request-guard.js';

/** アプリの組み立てに必要な設定(許可リストだけ) */
export type AppConfig = Pick<ServerConfig, 'allowedHosts' | 'allowedOrigins'>;

/**
 * Hono アプリを組み立てる
 *
 * Host / Origin の検証は、最初のミドルウェアとして、すべてのパスとメソッドに掛ける
 * (存在しないルートも対象。ルートの有無で応答を変えない)。
 *
 * @param config 許可リスト
 * @returns 組み立てた Hono アプリ
 */
export function createApp(config: AppConfig): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    // X-Forwarded-Host や Forwarded は見ない。信用するのは Host ヘッダだけ(C-1)
    const result = checkRequest(
      {
        method: c.req.method,
        host: c.req.header('host'),
        origin: c.req.header('origin'),
        contentType: c.req.header('content-type'),
      },
      config
    );
    if (!result.ok) {
      // 応答には固定の理由だけを載せる。受け取ったヘッダの値は返さない(C-5)
      return c.json({ error: 'forbidden', reason: result.reason }, 403);
    }
    await next();
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  return app;
}
