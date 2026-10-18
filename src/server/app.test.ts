/**
 * T1-1: Hono アプリの単体テスト(C-1、C-2、C-5、/healthz)
 *
 * 検証のミドルウェアが、すべてのパスとメソッド(存在しないルートを含む)に掛かっていることを確かめる。
 * 実際の TCP 接続を使う確認は server.test.ts で行う。
 */
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const HOST = '127.0.0.1:3000';
const ORIGIN = 'http://127.0.0.1:3000';
const CONFIG = {
  // 存在しないディレクトリ。このファイルのテストは、リポジトリを読むところまで進まない
  repoDir: '/nonexistent-repo',
  allowedHosts: ['127.0.0.1:3000', 'localhost:3000'],
  allowedOrigins: ['http://127.0.0.1:3000', 'http://localhost:3000'],
};

/**
 * アプリへリクエストを送る
 *
 * `app.request()` に Headers を渡すと、実行環境が Host を取り除くことがあるため、
 * Request を自分で組み立てず、ヘッダは素のオブジェクトで渡す。
 *
 * @param path リクエストのパス
 * @param init メソッド、ヘッダ、本文
 * @returns 応答
 */
async function send(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Response> {
  const app = createApp(CONFIG);
  return app.request(`http://internal.invalid${path}`, init);
}

describe('T1-1: GET /healthz', () => {
  it('T1-1: Host が許可リスト内なら 200 を返す', async () => {
    const res = await send('/healthz', { headers: { Host: HOST } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('C-1: Host の検証は、すべてのリクエストに掛かる', () => {
  it.each(['/healthz', '/api/reports', '/api/file?path=src/example.ts', '/no-such-route', '/'])(
    'C-1: GET %s は、Host が許可リスト外なら 403',
    async (path) => {
      const res = await send(path, { headers: { Host: 'evil.com' } });
      expect(res.status).toBe(403);
    }
  );

  it('C-1: Host ヘッダが無ければ 403(URL のホスト名では代用しない)', async () => {
    const app = createApp({ ...CONFIG, allowedHosts: ['internal.invalid'] });
    const res = await app.request('http://internal.invalid/healthz');
    expect(res.status).toBe(403);
  });

  it('C-1: X-Forwarded-Host と Forwarded は信用しない', async () => {
    const res = await send('/healthz', {
      headers: { Host: 'evil.com', 'X-Forwarded-Host': HOST, Forwarded: `host=${HOST}` },
    });
    expect(res.status).toBe(403);
  });

  it('C-1: POST でも、Host が許可リスト外なら 403', async () => {
    const res = await send('/api/comments', {
      method: 'POST',
      headers: { Host: 'evil.com', Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('C-1: Host が許可リスト内で、ルートが無ければ 404(403 ではない)', async () => {
    const res = await send('/no-such-route', { headers: { Host: HOST } });
    expect(res.status).toBe(404);
  });
});

describe('C-2: Origin / Content-Type の検証は、ルートの有無に関係なく掛かる', () => {
  const mutations: Array<[method: string, path: string]> = [
    ['POST', '/api/comments'],
    ['PATCH', '/api/comments/some-id'],
    ['POST', '/api/comments/some-id/replies'],
    ['DELETE', '/api/comments/some-id'],
    ['PUT', '/api/comments/some-id'],
    ['POST', '/healthz'],
  ];

  it.each(mutations)('C-2: %s %s は、Origin が許可リスト外なら 403', async (method, path) => {
    const res = await send(path, {
      method,
      headers: { Host: HOST, Origin: 'http://evil.com', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it.each(mutations)(
    'C-2: %s %s は、Origin が無く Content-Type が JSON でないなら 403',
    async (method, path) => {
      const res = await send(path, {
        method,
        headers: { Host: HOST, 'Content-Type': 'text/plain' },
        body: '{}',
      });
      expect(res.status).toBe(403);
    }
  );

  it('C-2: POST で Origin が許可リスト内なら、403 にはならない(ルートが無いので 404)', async () => {
    const res = await send('/api/comments', {
      method: 'POST',
      headers: { Host: HOST, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('C-2: POST で Origin が無くても、Content-Type が JSON なら 403 にはならない', async () => {
    const res = await send('/api/comments', {
      method: 'POST',
      headers: { Host: HOST, 'Content-Type': 'application/json; charset=utf-8' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('C-2: GET は、Origin が許可リスト外でも拒否しない', async () => {
    const res = await send('/healthz', { headers: { Host: HOST, Origin: 'http://evil.com' } });
    expect(res.status).toBe(200);
  });
});

describe('C-5: 拒否の応答に、受け取った値を載せない', () => {
  it('C-5: 403 の本文は固定の理由だけで、Host / Origin / 本文の値を含まない', async () => {
    const marker = 'unit-test-marker-9f3a';
    const res = await send(`/api/file?path=${marker}`, {
      method: 'POST',
      headers: {
        Host: `${marker}.evil.com`,
        Origin: `http://${marker}.evil.com`,
        Authorization: `Bearer ${marker}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ secret: marker }),
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain(marker);
    expect(JSON.parse(text)).toEqual({ error: 'forbidden', reason: 'host_not_allowed' });
  });
});
