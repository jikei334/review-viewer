/**
 * e2e セキュリティテスト(全ステージ共通の基準)
 * 対象基準: C-1(Host 検証)、C-2(Origin / CSRF 検証)、C-3(bind アドレス)、
 *           C-5(秘密を出さない)、C-6(SIGTERM / SIGINT)
 *
 * SPEC §2.5 と §3 だけを根拠とする。src/ は読まない。
 * C-4 は静的チェック(Coder の担当)なので、ここでは扱わない。
 *
 * 注意: Node.js の fetch は Host ヘッダの上書きを無視するため、
 * helpers/http.ts の request(node:http を直接使う)でリクエストを送る。
 */

import { networkInterfaces } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeniedFiles, type DeniedFile } from './helpers/fixtures.js';
import { canConnect, probeConnect, request, waitUntil } from './helpers/http.js';
import { startTestServer, stopIfStarted, type TestServer } from './helpers/server.js';

/**
 * ループバック以外の、このマシン自身の IPv4 アドレスを1つ探す
 * @returns 見つかったアドレス。無ければ undefined
 */
function findNonLoopbackIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

// ─── C-1: Host ヘッダ検証 ────────────────────────────────────────────────────

describe('C-1: Host header validation', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await stopIfStarted(server);
  });

  it('C-1: 許可リスト内の Host(127.0.0.1:PORT)は通過する', async () => {
    const res = await request(server, '/healthz', {
      headers: { Host: `127.0.0.1:${server.port}` },
    });
    expect(res.status).toBe(200);
  });

  it('C-1: 許可リスト内の Host(localhost:PORT)は通過する', async () => {
    const res = await request(server, '/healthz', {
      headers: { Host: `localhost:${server.port}` },
    });
    expect(res.status).toBe(200);
  });

  // 許可リスト外の Host。典型的な回避パターンを含む({port} は実際のポートに置き換える)
  const deniedHosts = [
    'evil.com',
    'evil.com:{port}',
    'attacker.local:{port}',
    // ポートなし・ポート違いは、既定の許可リスト(127.0.0.1:PORT,localhost:PORT)に一致しない
    '127.0.0.1',
    'localhost',
    '127.0.0.1:1',
    // 前方一致・後方一致・部分一致で誤って通してしまう実装を狙う
    '127.0.0.1.evil.com:{port}',
    'localhost.evil.com:{port}',
    'evil-localhost:{port}',
    // 別の表記のループバック。許可リストに無い以上、通してはいけない
    '0.0.0.0:{port}',
    '[::1]:{port}',
  ];

  it.each(deniedHosts)('C-1: 許可リスト外の Host(%s)は GET /healthz で 403 になる', async (pattern) => {
    const host = pattern.replaceAll('{port}', String(server.port));
    const res = await request(server, '/healthz', { headers: { Host: host } });
    expect(res.status, `Host: ${host}`).toBe(403);
  });

  // Host として構文が壊れている値。許可リスト外なので通してはいけない。
  // 決定済み(2026-10-18, Q12): Host が無い・形式が不正なときは 403 または 400 のどちらでもよい
  const malformedHosts = [
    '127.0.0.1:{port}.evil.com',
    'localhost:{port}.evil.com',
    '127.0.0.1:{port}@evil.com',
    'evil.com/127.0.0.1:{port}',
  ];

  it.each(malformedHosts)('C-1: 構文が壊れた Host(%s)は通過しない(403 または 400)', async (pattern) => {
    const host = pattern.replaceAll('{port}', String(server.port));
    const res = await request(server, '/healthz', { headers: { Host: host } });
    expect([400, 403], `Host: ${host} に対して ${res.status} が返った`).toContain(res.status);
  });

  it.each(['/api/reports', '/api/tree?path=', '/api/file?path=src/example.ts', '/api/comments'])(
    'C-1: API(GET %s)にも Host 検証が適用され、許可リスト外は 403 になる',
    async (path) => {
      const res = await request(server, path, { headers: { Host: 'evil.com' } });
      expect(res.status).toBe(403);
      // 拒否した応答に、ファイルの中身を載せない
      expect(res.text).not.toContain('increment');
    }
  );

  it('C-1: 状態を変更するリクエスト(POST)でも、許可リスト外の Host は 403 になる', async () => {
    const res = await request(server, '/api/comments', {
      method: 'POST',
      headers: {
        Host: 'evil.com',
        Origin: `http://127.0.0.1:${server.port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('C-1: X-Forwarded-Host に許可された値を入れても、Host が許可リスト外なら 403 になる', async () => {
    const res = await request(server, '/healthz', {
      headers: {
        Host: 'evil.com',
        'X-Forwarded-Host': `127.0.0.1:${server.port}`,
        Forwarded: `host=127.0.0.1:${server.port}`,
      },
    });
    expect(res.status).toBe(403);
  });
});

describe('C-1: 絶対形式のリクエスト行', () => {
  it('C-1: リクエスト行に許可された URL を書いても、Host ヘッダが許可リスト外なら 403 になる', async () => {
    const server = await startTestServer();
    try {
      // GET http://127.0.0.1:PORT/healthz HTTP/1.1 + Host: evil.com
      const res = await request(server, `http://127.0.0.1:${server.port}/healthz`, {
        headers: { Host: 'evil.com' },
      });
      expect(res.status).toBe(403);
    } finally {
      await server.stop();
    }
  });
});

describe('C-1: ALLOWED_HOSTS の指定と既定値', () => {
  it('C-1: ALLOWED_HOSTS を指定すると、その値だけが許可される', async () => {
    const server = await startTestServer({
      allowedHosts: 'review.test:{port}',
      healthHost: 'review.test:{port}',
    });
    try {
      const allowed = await request(server, '/healthz', {
        headers: { Host: `review.test:${server.port}` },
      });
      expect(allowed.status).toBe(200);

      // 既定では許可される値も、指定したリストに無ければ拒否される
      const denied = await request(server, '/healthz', {
        headers: { Host: `127.0.0.1:${server.port}` },
      });
      expect(denied.status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  it('C-1: ALLOWED_HOSTS が未設定なら、既定(127.0.0.1:PORT と localhost:PORT)だけが許可される', async () => {
    const server = await startTestServer({ omitEnv: ['ALLOWED_HOSTS'] });
    try {
      for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`]) {
        const res = await request(server, '/healthz', { headers: { Host: host } });
        expect(res.status, `Host: ${host}`).toBe(200);
      }
      for (const host of ['evil.com', `evil.com:${server.port}`, '127.0.0.1']) {
        const res = await request(server, '/healthz', { headers: { Host: host } });
        expect(res.status, `Host: ${host}`).toBe(403);
      }
    } finally {
      await server.stop();
    }
  });
});

// ─── C-2: Origin / CSRF 検証 ─────────────────────────────────────────────────

describe('C-2: Origin/CSRF validation', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await stopIfStarted(server);
  });

  /**
   * 状態を変更するリクエスト。
   * POST / PATCH のパスは SPEC §2.2 のもの。DELETE は §2.2 に無いが、C-2 の文言
   * 「状態を変更するリクエスト(POST / PATCH / DELETE)」を根拠に含める
   */
  const mutations: Array<[method: string, path: string]> = [
    ['POST', '/api/comments'],
    ['PATCH', '/api/comments/some-id'],
    ['POST', '/api/comments/some-id/replies'],
    ['DELETE', '/api/comments/some-id'],
  ];

  it.each(mutations)('C-2: %s %s は、Origin が許可リスト外なら 403 になる', async (method, path) => {
    const res = await request(server, path, {
      method,
      headers: { Origin: 'http://evil.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  // 許可リスト外の Origin。典型的な回避パターンを含む({port} は実際のポートに置き換える)
  const deniedOrigins = [
    'http://evil.com',
    'http://evil.com:{port}',
    // サンドボックス化された iframe や data: URL からのリクエストは Origin: null になる
    'null',
    // スキーム違い・ポート違い・ポートなしは、既定の許可リストに一致しない
    'https://127.0.0.1:{port}',
    'http://127.0.0.1:1',
    'http://127.0.0.1',
    'http://localhost',
    // 前方一致・後方一致で誤って通してしまう実装を狙う
    'http://127.0.0.1:{port}.evil.com',
    'http://localhost:{port}.evil.com',
    'http://localhost.evil.com:{port}',
    'http://evil.com/http://127.0.0.1:{port}',
    'http://evil-localhost:{port}',
  ];

  it.each(deniedOrigins)(
    'C-2: POST で Origin が許可リスト外(%s)なら、Content-Type が JSON でも 403 になる',
    async (pattern) => {
      const origin = pattern.replaceAll('{port}', String(server.port));
      const res = await request(server, '/api/comments', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status, `Origin: ${origin}`).toBe(403);
    }
  );

  // Origin が無く、Content-Type が JSON でない(HTML のフォームで送れる種類を含む)
  const nonJsonContentTypes = [
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=e2e',
    // JSON という文字列を含むだけで、JSON ではない
    'text/plain; application/json',
    'text/plain; charset=application/json',
  ];

  it.each(nonJsonContentTypes)(
    'C-2: POST で Origin が無く、Content-Type が JSON でない(%s)なら 403 になる',
    async (contentType) => {
      const res = await request(server, '/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: '{"body":"x"}',
      });
      expect(res.status).toBe(403);
    }
  );

  it('C-2: POST で Origin も Content-Type も無いなら 403 になる', async () => {
    const res = await request(server, '/api/comments', { method: 'POST', body: '{"body":"x"}' });
    expect(res.status).toBe(403);
  });

  it.each(mutations)('C-2: %s %s は、Origin が無く Content-Type が JSON でないなら 403 になる', async (method, path) => {
    const res = await request(server, path, {
      method,
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('C-2: POST で Origin が無くても、Content-Type が JSON なら CSRF としては拒否されない', async () => {
    // ステージ1では POST のエンドポイントがまだ無いので、404 などは許容する。403 でなければよい
    const res = await request(server, '/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
  });

  it('C-2: POST で Origin が無くても、Content-Type が application/json; charset=utf-8 なら CSRF としては拒否されない', async () => {
    // パラメータ付きでも、種類は JSON
    const res = await request(server, '/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
  });

  it.each(['http://127.0.0.1:{port}', 'http://localhost:{port}'])(
    'C-2: POST で Origin が許可リスト内(%s)なら CSRF としては拒否されない',
    async (pattern) => {
      const origin = pattern.replaceAll('{port}', String(server.port));
      const res = await request(server, '/api/comments', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status, `Origin: ${origin}`).not.toBe(403);
    }
  );

  it('C-2: GET(状態を変更しない)は、Origin が無くても拒否されない', async () => {
    const res = await request(server, '/api/reports');
    expect(res.status).toBe(200);
  });
});

describe('C-2: ALLOWED_ORIGINS の指定', () => {
  it('C-2: ALLOWED_ORIGINS を指定すると、その値だけが許可される', async () => {
    const server = await startTestServer({ allowedOrigins: 'http://review.test:{port}' });
    try {
      const allowed = await request(server, '/api/comments', {
        method: 'POST',
        headers: { Origin: `http://review.test:${server.port}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(allowed.status).not.toBe(403);

      // 既定では許可される値も、指定したリストに無ければ拒否される
      const denied = await request(server, '/api/comments', {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${server.port}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(denied.status).toBe(403);
    } finally {
      await server.stop();
    }
  });
});

describe('C-2: ALLOWED_ORIGINS の既定値', () => {
  it('C-2: ALLOWED_ORIGINS が未設定でも、許可リスト外の Origin からの POST は 403 になる', async () => {
    const server = await startTestServer({ omitEnv: ['ALLOWED_ORIGINS'] });
    try {
      const denied = await request(server, '/api/comments', {
        method: 'POST',
        headers: { Origin: 'http://evil.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(denied.status).toBe(403);

      const allowed = await request(server, '/api/comments', {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${server.port}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(allowed.status).not.toBe(403);
    } finally {
      await server.stop();
    }
  });
});

// ─── C-3: 既定の bind アドレス ───────────────────────────────────────────────

describe('C-3: Default bind address', () => {
  let server: TestServer;
  const externalAddress = findNonLoopbackIPv4();

  beforeAll(async () => {
    // HOST を渡さずに起動して、既定の bind アドレスを確かめる
    server = await startTestServer({ omitEnv: ['HOST'] });
  });

  afterAll(async () => {
    await stopIfStarted(server);
  });

  it('C-3: HOST が未設定のとき、127.0.0.1 でリクエストを受け付ける', async () => {
    const res = await request(server, '/healthz');
    expect(res.status).toBe(200);
  });

  // Linux では 127.0.0.0/8 の全体がループバックで、127.0.0.2 もこのマシン自身を指す。
  // 127.0.0.1 だけに bind していれば 127.0.0.2:PORT は接続拒否(ECONNREFUSED)になり、
  // 0.0.0.0 や :: に bind していれば接続できてしまう。
  // ループバック以外のアドレスが無い環境(--network=none など)でも検証できる。
  // Linux 以外(macOS など)では 127.0.0.2 が既定で使えないため、スキップとして表示する
  it.skipIf(process.platform !== 'linux')(
    'C-3: HOST が未設定のとき、127.0.0.2 では接続を拒否する(127.0.0.1 だけに bind している)',
    async () => {
      const result = await probeConnect('127.0.0.2', server.port, 2_000);
      expect(
        result.outcome,
        `127.0.0.2:${server.port} への接続結果が ${result.outcome}(${result.code ?? 'コードなし'})だった`
      ).toBe('refused');
    }
  );

  // 0.0.0.0(全インターフェース)に bind していれば、ループバック以外のアドレスでも接続できてしまう。
  // ループバック以外のアドレスを持たない環境では検証できないので、スキップとして表示する
  it.skipIf(externalAddress === undefined)(
    'C-3: HOST が未設定のとき、ループバック以外のアドレスからは接続できない(0.0.0.0 に bind していない)',
    async () => {
      const connected = await canConnect(externalAddress as string, server.port, 2_000);
      expect(connected, `${externalAddress}:${server.port} に接続できてしまった`).toBe(false);
    }
  );
});

// ─── C-5: 秘密をログ・エラー・API 応答に出さない ─────────────────────────────

describe('C-5: Secrets are not exposed', () => {
  // 本物ではない、テスト用のダミーのトークン
  const DUMMY_TOKEN = `e2e-dummy-token-${Math.random().toString(36).slice(2)}-not-a-real-token`;

  it('C-5: 秘密ファイルの中身とトークンが、API 応答にもログにも出ない', async () => {
    let denied: DeniedFile[] = [];
    const server = await startTestServer({
      token: DUMMY_TOKEN,
      setup: async (repoDir) => {
        denied = await createDeniedFiles(repoDir);
      },
    });

    const responses: Array<{ label: string; text: string }> = [];
    try {
      // 秘密ファイルを、API から取得しようとする(拒否される想定。ここでは応答の中身だけを集める)
      for (const file of denied) {
        const res = await request(server, `/api/file?path=${encodeURIComponent(file.path)}`);
        responses.push({ label: `GET /api/file?path=${file.path}`, text: res.text });
      }
      for (const path of ['/healthz', '/api/reports', '/api/tree?path=', '/api/tree?path=subdir', '/no-such-path']) {
        const res = await request(server, path);
        responses.push({ label: `GET ${path}`, text: res.text });
      }
      // 拒否される応答(403)にも、秘密を載せない
      const forbidden = await request(server, '/api/file?path=.env', { headers: { Host: 'evil.com' } });
      responses.push({ label: 'GET /api/file?path=.env (Host: evil.com)', text: forbidden.text });
    } finally {
      // 停止してから(出力が出そろってから)ログを調べる
      await server.stop();
    }
    const logs = server.logs();

    for (const { label, text } of responses) {
      expect(text, `${label} の応答にトークンが含まれている`).not.toContain(DUMMY_TOKEN);
      for (const file of denied) {
        expect(text, `${label} の応答に ${file.path} の中身が含まれている`).not.toContain(file.sentinel);
      }
    }
    expect(logs, 'ログにトークンが含まれている').not.toContain(DUMMY_TOKEN);
    for (const file of denied) {
      expect(logs, `ログに ${file.path} の中身が含まれている`).not.toContain(file.sentinel);
    }
  });
});

// ─── C-6: SIGTERM / SIGINT で正常終了 ────────────────────────────────────────

describe('C-6: Graceful shutdown', () => {
  // /proc でサーバー本体のプロセスを探すため、Linux でのみ実行する
  it.skipIf(process.platform !== 'linux').each(['SIGTERM', 'SIGINT'] as const)(
    'C-6: %s を受けると、5 秒以内に終了コード 0 で終了し、ポートを閉じる',
    async (signal) => {
      const server = await startTestServer();
      try {
        const before = await request(server, '/healthz');
        expect(before.status).toBe(200);

        // stop() はシグナルを送り、プロセスが終了してポートが閉じるまでを待つ(上限 5 秒)。
        // SPEC C-6(2026-10-18 決定): 正常終了 = シグナルから 5 秒以内に、終了コード 0 で終了すること
        // サーバー本体の node プロセスだけにシグナルを送る。npm はサーバーの終了コードで終了するので、
        // それを観測できる(グループ全体に送ると npm 自身もシグナルで死に、終了コードが見えなくなる)
        const result = await server.stop(signal, true);
        expect(result.forced, `${signal} では終了せず、SIGKILL が必要だった`).toBe(false);
        expect(result.elapsedMs, `${signal} から終了までに ${result.elapsedMs}ms かかった`).toBeLessThanOrEqual(5_000);
        expect(result.exitCode, `${signal} での終了コードが 0 ではない。出力:\n${server.logs()}`).toBe(0);

        // 終了後は、接続を受け付けない
        const closed = await waitUntil(async () => !(await canConnect('127.0.0.1', server.port, 500)), 2_000);
        expect(closed).toBe(true);
      } finally {
        // 途中で失敗しても、プロセスと一時ディレクトリを残さない(stop は2回呼んでも最初の結果を返す)
        await server.stop();
      }
    }
  );

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'C-6: %s をプロセスグループ全体(端末の Ctrl+C と同じ届き方)に受けても、5 秒以内に終了し、ポートを閉じる',
    async (signal) => {
      const server = await startTestServer();
      try {
        const result = await server.stop(signal);
        expect(result.forced, `${signal} では終了せず、SIGKILL が必要だった`).toBe(false);
        expect(result.elapsedMs).toBeLessThanOrEqual(5_000);
        expect(await canConnect('127.0.0.1', server.port, 500)).toBe(false);
      } finally {
        await server.stop();
      }
    }
  );

  // 書き込みの途中でのシグナルは、書き込みが生じるステージ2の e2e/comments-durability.test.ts で検証している
});
