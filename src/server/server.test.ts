/**
 * T1-1: サーバーの起動と停止の単体テスト(C-1、C-3、C-6)
 *
 * 実際に 127.0.0.1 の空きポートで待ち受けて、node:http で接続する
 * (fetch は Host ヘッダを上書きできないため)。
 */
import { Agent, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from './config.js';
import {
  closeServer,
  closeResources,
  createShutdownHandler,
  describeError,
  registerShutdownSignals,
  SHUTDOWN_SIGNALS,
  startServer,
} from './server.js';

/** テスト用の Host ヘッダ(ポートは実行ごとに変わるので、許可リストを固定の値にする) */
const TEST_HOST = 'review.test:3000';

/** テスト用の設定。port=0 で、OS に空きポートを選ばせる */
const TEST_CONFIG: ServerConfig = {
  repoDir: '/nonexistent-repo',
  dataDir: '/nonexistent-data',
  host: '127.0.0.1',
  port: 0,
  allowedHosts: [TEST_HOST],
  allowedOrigins: ['http://review.test:3000'],
};

/** 後始末の対象 */
const openServers: Server[] = [];
const openAgents: Agent[] = [];

afterEach(async () => {
  for (const agent of openAgents.splice(0)) agent.destroy();
  for (const server of openServers.splice(0)) {
    if (server.listening) await closeServer(server, 0);
  }
});

/**
 * テスト用のサーバーを起動する(後始末に登録する)
 *
 * @returns サーバーと、そのポート番号
 */
async function start(): Promise<{ server: Server; port: number }> {
  const server = await startServer(TEST_CONFIG);
  openServers.push(server);
  return { server, port: (server.address() as AddressInfo).port };
}

/**
 * node:http でリクエストを送る
 *
 * @param port 接続先のポート
 * @param options パス、メソッド、ヘッダ、本文、接続の使い回しに使う Agent
 * @returns ステータスコードと本文
 */
function send(
  port: number,
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    agent?: Agent;
  } = {}
): Promise<{ status: number; text: string }> {
  return new Promise((resolveSend, rejectSend) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path ?? '/healthz',
        method: options.method ?? 'GET',
        headers: options.headers ?? { Host: TEST_HOST },
        agent: options.agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolveSend({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
        );
        res.on('error', rejectSend);
      }
    );
    req.on('error', rejectSend);
    req.end(options.body);
  });
}

describe('T1-1: startServer', () => {
  it('C-3: 設定の host(127.0.0.1)に bind する', async () => {
    const { server } = await start();
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('T1-1: GET /healthz が 200 を返す', async () => {
    const { port } = await start();
    const res = await send(port);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ status: 'ok' });
  });

  it('C-1: 実際の接続でも、許可リスト外の Host は 403', async () => {
    const { port } = await start();
    // 構文として正しい Host は、必ず 403(400 を許さない)
    for (const host of ['evil.com', `127.0.0.1:${port}`, 'review.test']) {
      const res = await send(port, { headers: { Host: host } });
      expect(res.status, `Host: ${host} に ${res.status} が返った`).toBe(403);
    }
  });

  it('C-1: 構文が壊れた Host は通過しない(403 または 400)', async () => {
    const { port } = await start();
    // ポートの位置に数字以外が続く値は、HTTP の層が 400 で拒否することがある
    const host = 'review.test:3000.evil.com';
    const res = await send(port, { headers: { Host: host } });
    expect([400, 403], `Host: ${host} に ${res.status} が返った`).toContain(res.status);
  });

  it('C-1: リクエスト行が絶対形式の URL でも、Host ヘッダで判定する', async () => {
    const { port } = await start();
    const res = await send(port, {
      path: `http://${TEST_HOST}/healthz`,
      headers: { Host: 'evil.com' },
    });
    expect(res.status).toBe(403);
  });

  it('C-2: 実際の接続でも、許可リスト外の Origin からの POST は 403', async () => {
    const { port } = await start();
    const res = await send(port, {
      path: '/api/comments',
      method: 'POST',
      headers: { Host: TEST_HOST, Origin: 'http://evil.com', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('T1-1: ポートが使用中なら、起動に失敗する(エラーを握りつぶさない)', async () => {
    const { port } = await start();
    await expect(startServer({ ...TEST_CONFIG, port })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
});

describe('C-6: closeServer', () => {
  it('C-6: 停止すると、待ち受けをやめる', async () => {
    const { server, port } = await start();
    await closeServer(server, 1000);
    expect(server.listening).toBe(false);
    await expect(send(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('C-6: keep-alive の接続が残っていても、待ち時間を使い切らずに停止できる', async () => {
    const { server, port } = await start();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    openAgents.push(agent);
    const res = await send(port, { agent });
    expect(res.status).toBe(200);

    const startedAt = Date.now();
    await closeServer(server, 10_000);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('C-6: 処理が終わらない接続が残っていても、待ち時間の後に切断して停止する', async () => {
    const { server, port } = await start();
    // ヘッダを送りきらない接続(サーバーから見て、使用中のままの接続)
    const { connect } = await import('node:net');
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once('connect', () => resolveConnect());
      socket.once('error', rejectConnect);
    });
    socket.on('error', () => {
      // サーバー側からの切断(ECONNRESET)は、このテストが期待している動作
    });
    socket.write('GET /healthz HTTP/1.1\r\nHost: ');
    // サーバーが、この接続を受け取るまで待つ
    await vi.waitFor(async () => {
      const count = await new Promise<number>((resolveCount, rejectCount) => {
        server.getConnections((err, n) => (err ? rejectCount(err) : resolveCount(n)));
      });
      expect(count).toBeGreaterThanOrEqual(1);
    });

    const startedAt = Date.now();
    await closeServer(server, 200);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(3_000);
    socket.destroy();
  });

  it('C-6: すでに停止しているサーバーを閉じようとすると、エラーになる(握りつぶさない)', async () => {
    const { server } = await start();
    await closeServer(server, 0);
    await expect(closeServer(server, 0)).rejects.toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' });
  });
});

describe('C-6: createShutdownHandler', () => {
  it('C-6: 閉じる処理が成功したら、終了コード 0 で終了する', async () => {
    const exit = vi.fn();
    const close = vi.fn(() => Promise.resolve());
    const handler = createShutdownHandler({ close, log: vi.fn(), exit });

    handler('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('C-6: 閉じる処理が終わるまでは、終了しない', async () => {
    const exit = vi.fn();
    let finish: () => void = () => undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolveClose) => {
          finish = resolveClose;
        })
    );
    const handler = createShutdownHandler({ close, log: vi.fn(), exit });

    handler('SIGINT');
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
  });

  it('C-6: シグナルを続けて受けても、閉じる処理は1回だけ', async () => {
    const exit = vi.fn();
    const close = vi.fn(() => Promise.resolve());
    const handler = createShutdownHandler({ close, log: vi.fn(), exit });

    handler('SIGTERM');
    handler('SIGINT');
    handler('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('C-6: 閉じる処理が失敗したら、ログに残して終了コード 1 で終了する', async () => {
    const exit = vi.fn();
    const log = vi.fn();
    const handler = createShutdownHandler({
      close: () => Promise.reject(new Error('close failed')),
      log,
      exit,
    });

    handler('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log.mock.calls.flat().join('\n')).toContain('close failed');
  });
});

describe('C-6: registerShutdownSignals', () => {
  it('C-6: SIGTERM と SIGINT の両方に、同じハンドラを明示的に登録する', () => {
    const on = vi.fn();
    const handler = vi.fn();

    registerShutdownSignals({ on }, handler);

    expect(SHUTDOWN_SIGNALS).toEqual(['SIGTERM', 'SIGINT']);
    expect(on.mock.calls).toEqual([
      ['SIGTERM', handler],
      ['SIGINT', handler],
    ]);
  });

  it('C-6: 待ち受けを始める前(閉じるサーバーがまだ無い状態)にシグナルが届いたら、そのまま終了コード 0 で終了する', async () => {
    // index.ts と同じ組み立て: 登録が先、起動が後。サーバーが無い間は、閉じるものが無い
    const listeners = new Map<string, (signal: string) => void>();
    const exit = vi.fn();
    const closeStarted = vi.fn();
    const holder: { server?: Server } = {};
    const handler = createShutdownHandler({
      close: () => {
        if (holder.server === undefined) return Promise.resolve();
        closeStarted();
        return closeServer(holder.server);
      },
      log: vi.fn(),
      exit,
    });
    registerShutdownSignals({ on: (signal, listener) => listeners.set(signal, listener) }, handler);

    listeners.get('SIGTERM')?.('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(closeStarted).not.toHaveBeenCalled();
  });

  it('C-6: 登録したハンドラは、起動後のシグナルでサーバーを閉じてから終了する', async () => {
    const listeners = new Map<string, (signal: string) => void>();
    const exit = vi.fn();
    const { server } = await start();
    const handler = createShutdownHandler({
      close: () => closeServer(server, 1000),
      log: vi.fn(),
      exit,
    });
    registerShutdownSignals({ on: (signal, listener) => listeners.set(signal, listener) }, handler);

    listeners.get('SIGINT')?.('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(server.listening).toBe(false);
  });
});

describe('T1-1: describeError', () => {
  it('T1-1: Error は「名前: メッセージ」にする', () => {
    expect(describeError(new TypeError('bad'))).toBe('TypeError: bad');
  });

  it('T1-1: Error 以外は文字列にする', () => {
    expect(describeError('oops')).toBe('oops');
  });
});

describe('S2-2 / C-6: closeResources', () => {
  it('S2-2: 受け付けを止めてからサーバーを閉じ、書き込みの完了を待ってから解決する', async () => {
    const { server } = await start();
    const order: string[] = [];
    let finish: () => void = () => undefined;
    const store = {
      beginShutdown: () => order.push('begin'),
      drain: () =>
        new Promise<void>((r) => {
          order.push('drain');
          finish = r;
        }),
    };
    let done = false;
    const closing = closeResources({ server, store }, 0).then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(order).toEqual(['begin', 'drain']));
    expect(done).toBe(false);
    finish();
    await closing;
    expect(done).toBe(true);
  });

  it('C-6: サーバーもストアも無い(起動前)なら、何もせず解決する', async () => {
    await expect(closeResources({})).resolves.toBeUndefined();
  });
});
