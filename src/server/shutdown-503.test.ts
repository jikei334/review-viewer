/**
 * T2-9: 終了処理中の書き込みの 503 の単体テスト(S2-2、C-5)
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTempRepo, type TempRepo } from './__fixtures__/temp-repo.js';
import { createApp } from './app.js';
import { openReviewService } from './service-factory.js';

const HOST = '127.0.0.1:3000';
const GUARD = {
  allowedHosts: [HOST],
  allowedOrigins: ['http://127.0.0.1:3000'],
};

let repo: TempRepo;

beforeAll(async () => {
  repo = await createTempRepo();
  await repo.write('src/example.ts', 'one\ntwo\nthree\n');
});

afterAll(async () => {
  await repo.cleanup();
});

/**
 * JSON を送る
 *
 * @param app 対象のアプリ
 * @param method メソッド
 * @param path パス
 * @param payload 本文
 * @returns 応答
 */
async function send(app: ReturnType<typeof createApp>, method: string, path: string, payload: unknown): Promise<Response> {
  return await app.request(`http://internal.invalid${path}`, {
    method,
    headers: { Host: HOST, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('S2-2: 終了処理中の書き込み', () => {
  it('S2-2: POST / PATCH / 返信は 503 の固定の応答で断り、保存しない。読み取りは応答する', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rv-unit-503-'));
    try {
      const { service, store } = await openReviewService({ repoDir: repo.repoDir, dataDir }, () => undefined);
      const app = createApp({ ...GUARD, repoDir: repo.repoDir, dataDir }, { service, log: () => undefined });
      const body = { path: 'src/example.ts', startLine: 1, endLine: 1, body: 'SECRET_503_SENTINEL', type: 'note' };
      const created = (await (await send(app, 'POST', '/api/comments', body)).json()) as { id: string };

      store.beginShutdown();

      const results = [
        await send(app, 'POST', '/api/comments', body),
        await send(app, 'PATCH', `/api/comments/${created.id}`, { status: 'resolved' }),
        await send(app, 'POST', `/api/comments/${created.id}/replies`, { body: 'x' }),
      ];
      for (const res of results) {
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: 'shutting_down' });
      }
      const list = await app.request('http://internal.invalid/api/comments', { headers: { Host: HOST } });
      expect(list.status).toBe(200);
      expect(((await list.json()) as { comments: unknown[] }).comments).toHaveLength(1);
      expect(readdirSync(dataDir)).toEqual(['comments.json']);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('S2-3: openReviewService は、読み込みの前に残存の一時ファイルを掃除してログに残す', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'rv-unit-503-'));
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dataDir, 'comments.json.7.1.tmp'), '{"ver');
      const lines: string[] = [];
      await openReviewService({ repoDir: repo.repoDir, dataDir }, (l) => lines.push(l));
      expect(readdirSync(dataDir)).toEqual([]);
      expect(lines.join('\n')).toContain('1 件');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
