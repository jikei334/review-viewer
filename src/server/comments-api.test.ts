/**
 * T2-3: コメント API(POST・GET /api/comments)の単体テスト
 * (S2-1、S2-4、C-1、C-2、C-5)
 *
 * Hono アプリを、TCP を使わずに `app.request()` で直接呼ぶ。実際の RepoReader / ReviewStore を使う。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, type TempRepo } from './__fixtures__/temp-repo.js';
import { createApp } from './app.js';
import { openReviewService } from './service-factory.js';

const HOST = '127.0.0.1:3000';
const ORIGIN = 'http://127.0.0.1:3000';
const GUARD = {
  allowedHosts: ['127.0.0.1:3000', 'localhost:3000'],
  allowedOrigins: [ORIGIN, 'http://localhost:3000'],
};
const SECRET = 'UNIT_COMMENTS_API_SECRET_SENTINEL';

let repo: TempRepo;
let dataDir = '';
let app: ReturnType<typeof createApp>;
const logLines: string[] = [];

beforeAll(async () => {
  repo = await createTempRepo();
  await repo.write('src/example.ts', 'one\ntwo\nthree\n');
  await repo.write('.env', `${SECRET}\n`);
  await repo.write('.gitignore', 'ignored.txt\n');
  await repo.write('ignored.txt', `${SECRET}\n`);
  await repo.write('image.bin', Buffer.from([0x89, 0x00, 0x01]));
  const outside = await repo.writeOutside('secret.txt', `${SECRET}\n`);
  await repo.link(outside, 'link-out.txt');
});

afterAll(async () => {
  await repo.cleanup();
});

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rv-unit-api-'));
  const { service } = await openReviewService({ repoDir: repo.repoDir, dataDir });
  app = createApp({ ...GUARD, repoDir: repo.repoDir, dataDir }, { service, log: (l) => logLines.push(l) });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  logLines.length = 0;
});

/**
 * POST /api/comments を送る
 *
 * @param payload JSON(文字列ならそのまま本文)
 * @param headers 追加のヘッダ
 * @returns 応答
 */
function post(payload: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.request('http://internal.invalid/api/comments', {
      method: 'POST',
      headers: { Host: HOST, 'Content-Type': 'application/json', ...headers },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    })
  );
}

/**
 * GET /api/comments を送る
 *
 * @param query クエリ文字列('?' なし)
 * @returns 応答
 */
function get(query = ''): Promise<Response> {
  return Promise.resolve(
    app.request(`http://internal.invalid/api/comments${query === '' ? '' : `?${query}`}`, { headers: { Host: HOST } })
  );
}

/**
 * 有効な作成リクエスト
 *
 * @param over 上書きする項目
 * @returns リクエストの JSON
 */
function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { path: 'src/example.ts', startLine: 1, endLine: 2, body: 'メモ', type: 'note', ...over };
}

/**
 * 一覧の件数
 *
 * @returns コメント数
 */
async function count(): Promise<number> {
  return ((await (await get()).json()) as { comments: unknown[] }).comments.length;
}

describe('S2-1: POST /api/comments', () => {
  it('S2-1: 201 と Comment を返す(author=human、status=open)', async () => {
    const res = await post(valid({ type: 'instruction' }));
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
    const c = (await res.json()) as Record<string, unknown>;
    expect(c).toMatchObject({
      path: 'src/example.ts',
      body: 'メモ',
      author: 'human',
      type: 'instruction',
      status: 'open',
      replies: [],
      resolution: null,
      anchor: { startLine: 1, endLine: 2, quote: 'one\ntwo' },
    });
    expect((c['anchor'] as { docHash: string }).docHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['JSON でない', '{not json'],
    ['空の本文', ''],
    ['配列', '[]'],
    ['null', 'null'],
    ['author を含む', valid({ author: 'ai' })],
    ['未知のフィールド', valid({ extra: 1 })],
    ['欠落', { path: 'src/example.ts' }],
    ['空白だけの本文', valid({ body: '  \n' })],
    ['行範囲がファイルの行数を超える', valid({ endLine: 4 })],
    ['バイナリ', valid({ path: 'image.bin' })],
    ['path が ..', valid({ path: '../secret.txt' })],
    ['path が絶対', valid({ path: '/etc/passwd' })],
    ['path が ./ つき', valid({ path: './src/example.ts' })],
    ['path が //', valid({ path: 'src//example.ts' })],
    ['path がバックスラッシュ', valid({ path: 'src\\example.ts' })],
    ['path が末尾 /', valid({ path: 'src/example.ts/' })],
  ])('S2-1・S2-4: %s は 400 で、コメントは作られない', async (_label, payload) => {
    const res = await post(payload);
    expect(res.status).toBe(400);
    expect(await count()).toBe(0);
  });

  it.each([
    ['存在しない', 'no/such.ts'],
    ['秘密ファイル', '.env'],
    ['.gitignore の対象', 'ignored.txt'],
    ['リポジトリ外を指すリンク', 'link-out.txt'],
    ['ディレクトリ', 'src'],
  ])('S2-4: %s は 404 で、応答は互いに区別できない', async (_label, path) => {
    const res = await post(valid({ path }));
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text.replaceAll(path, '<PATH>')).toBe(JSON.stringify({ error: 'not_found' }));
    expect(await count()).toBe(0);
  });

  it('C-2: Origin が許可リスト外なら 403 で、コメントは作られない', async () => {
    const res = await post(valid(), { Origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(await count()).toBe(0);
  });

  it('C-2: Origin が無く JSON でない Content-Type なら 403', async () => {
    const res = await post(JSON.stringify(valid()), { 'Content-Type': 'text/plain' });
    expect(res.status).toBe(403);
    expect(await count()).toBe(0);
  });

  it('C-2: 許可された Origin + JSON なら作成できる', async () => {
    expect((await post(valid(), { Origin: ORIGIN })).status).toBe(201);
  });

  it('C-1: Host が許可リスト外なら 403', async () => {
    const res = await post(valid(), { Host: 'evil.example' });
    expect(res.status).toBe(403);
    expect(await count()).toBe(0);
  });

  it('C-5: 400・404 の応答とログに、本文・パス・秘密を出さない', async () => {
    await post(valid({ path: '.env', body: 'BODY_SENTINEL' }));
    await post(valid({ body: ' ', path: 'PATH_SENTINEL/x' }));
    const res = await post({ ...valid(), body: 'BODY_SENTINEL', extra: 'EXTRA_SENTINEL' });
    const text = await res.text();
    expect(text).not.toMatch(/BODY_SENTINEL|EXTRA_SENTINEL|PATH_SENTINEL/);
    expect(logLines.join('\n')).not.toMatch(/BODY_SENTINEL|EXTRA_SENTINEL|PATH_SENTINEL|UNIT_COMMENTS/);
  });
});

describe('S2-1・S2-4: GET /api/comments', () => {
  it('S2-1: 作成したコメントが、作成順で返る', async () => {
    await post(valid({ body: 'first' }));
    await post(valid({ body: 'second' }));
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: Array<{ body: string }> };
    expect(body.comments.map((c) => c.body)).toEqual(['first', 'second']);
  });

  it('S2-1: path・status・type で絞れる。空文字の値は指定なし', async () => {
    await post(valid({ body: 'n' }));
    await post(valid({ body: 'i', type: 'instruction' }));
    const bodies = async (q: string): Promise<string[]> =>
      ((await (await get(q)).json()) as { comments: Array<{ body: string }> }).comments.map((c) => c.body);
    expect(await bodies('type=instruction')).toEqual(['i']);
    expect(await bodies('status=open&path=src%2Fexample.ts')).toEqual(['n', 'i']);
    expect(await bodies('status=resolved')).toEqual([]);
    expect(await bodies('status=&type=&path=')).toEqual(['n', 'i']);
  });

  it.each(['status=bogus', 'type=bogus', 'status=OPEN', 'type=Note', 'status=open&status=open', 'path=a&path=b'])(
    'S2-1: 不正な絞り込み(%s)は 400',
    async (q) => {
      expect((await get(q)).status).toBe(400);
    }
  );

  it.each(['no%2Fsuch.ts', '.env', 'ignored.txt', 'link-out.txt', '.git%2Fconfig'])(
    'S2-4: 存在しない・拒否対象のパス(%s)は 200 と空の一覧で、応答は同じ',
    async (p) => {
      await post(valid());
      const res = await get(`path=${p}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(JSON.stringify({ comments: [] }));
    }
  );

  it.each(['..%2Fx', '%2Fetc%2Fpasswd', 'a%00b', 'a%2F', '.%2Fa', 'a%2F%2Fb', 'a%5Cb'])(
    'S2-4: 形式が正しくないパス(%s)は 400',
    async (p) => {
      expect((await get(`path=${p}`)).status).toBe(400);
    }
  );
});

describe('S2-1: 保存の失敗', () => {
  it('S2-1: 保存できないときは 500 を返し、ログには本文を出さない', async () => {
    rmSync(dataDir, { recursive: true, force: true });
    const res = await post(valid({ body: 'BODY_SENTINEL_SAVE' }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('BODY_SENTINEL_SAVE');
    expect(logLines.join('\n')).not.toContain('BODY_SENTINEL_SAVE');
    expect(logLines.length).toBeGreaterThan(0);
  });
});
