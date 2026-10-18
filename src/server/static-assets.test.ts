/**
 * T1-3: 画面の静的ファイルの配信の単体テスト(S1-7、C-1、C-2 の回帰を含む)
 *
 * 一時ディレクトリに、画面のビルド成果物に見立てたファイルを作って使う。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { StaticAssets, StaticAssetsUnavailableError } from './static-assets.js';

const HOST = '127.0.0.1:3000';
const CONFIG = {
  repoDir: '/nonexistent-repo',
  allowedHosts: ['127.0.0.1:3000', 'localhost:3000'],
  allowedOrigins: ['http://127.0.0.1:3000', 'http://localhost:3000'],
};

let dir: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rv-assets-'));
  outside = mkdtempSync(join(tmpdir(), 'rv-outside-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Review Viewer</title>');
  writeFileSync(join(dir, 'assets', 'app-abc.js'), 'console.log(1);');
  writeFileSync(join(dir, 'assets', 'app-abc.css'), 'body{}');
  writeFileSync(join(dir, 'assets', 'data.unknown'), 'x');
  writeFileSync(join(outside, 'secret.js'), 'SECRET-OUTSIDE');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/**
 * 画面を配信するアプリへ、GET リクエストを送る
 *
 * @param path リクエストのパス
 * @param headers ヘッダ(省略時は許可された Host)
 * @returns 応答
 */
async function get(path: string, headers: Record<string, string> = { Host: HOST }): Promise<Response> {
  const assets = await StaticAssets.load(dir);
  return createApp(CONFIG, { assets }).request(`http://internal.invalid${path}`, { headers });
}

describe('StaticAssets.load', () => {
  it('T1-3: index.html が無いディレクトリは受け付けない', async () => {
    rmSync(join(dir, 'index.html'));
    await expect(StaticAssets.load(dir)).rejects.toBeInstanceOf(StaticAssetsUnavailableError);
  });

  it('T1-3: 存在しないディレクトリは受け付けない(メッセージにパスを含めない)', async () => {
    const error = await StaticAssets.load(join(dir, 'no-such')).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StaticAssetsUnavailableError);
    expect((error as Error).message).not.toContain(dir);
  });
});

describe('GET / と静的ファイル', () => {
  it('S1-2: GET / が画面(HTML)を返す', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('Review Viewer');
  });

  it('T1-3: assets/ のファイルを、種類に合った Content-Type で返す', async () => {
    const js = await get('/assets/app-abc.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    const css = await get('/assets/app-abc.css');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('T1-3: HTML は毎回確認させる(no-cache)', async () => {
    expect((await get('/')).headers.get('cache-control')).toBe('no-cache');
  });

  it('T1-3: 対応表に無いパス、未知の拡張子のファイルは 404', async () => {
    expect((await get('/nope.js')).status).toBe(404);
    expect((await get('/assets/data.unknown')).status).toBe(404);
    expect((await get('/assets/')).status).toBe(404);
  });

  it.each([
    '/../secret.js',
    '/assets/../../secret.js',
    '/assets/%2e%2e/%2e%2e/secret.js',
    '/%2e%2e/secret.js',
    '/assets/..%2f..%2fsecret.js',
    '/assets/app-abc.js%00.png',
    '//etc/passwd',
  ])('S1-4: パスをたどる %s は、ディレクトリの外のファイルを返さない', async (path) => {
    const res = await get(path);
    expect(await res.text()).not.toContain('SECRET-OUTSIDE');
    expect([403, 404]).toContain(res.status);
  });

  it('S1-4: ディレクトリの外を指すシンボリックリンクは、配信しない', async () => {
    symlinkSync(join(outside, 'secret.js'), join(dir, 'assets', 'link.js'));
    const res = await get('/assets/link.js');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('SECRET-OUTSIDE');
  });

  it('T1-3: /api/ 以下の未知のパスは、画面のファイルで代用せず 404', async () => {
    expect((await get('/api/unknown')).status).toBe(404);
  });

  it('T1-3: 画面を配信しないアプリ(assets 省略)では GET / は 404', async () => {
    const res = await createApp(CONFIG).request('http://internal.invalid/', { headers: { Host: HOST } });
    expect(res.status).toBe(404);
  });
});

describe('画面の応答にも、既存のセキュリティ検証が掛かる', () => {
  it('C-1: GET / は、Host が許可リスト外なら 403', async () => {
    expect((await get('/', { Host: 'evil.com' })).status).toBe(403);
  });

  it('C-1: 静的ファイルも、Host が許可リスト外なら 403', async () => {
    expect((await get('/assets/app-abc.js', { Host: 'evil.com:3000' })).status).toBe(403);
  });

  it('C-2: POST / は、Origin が許可リスト外なら 403', async () => {
    const assets = await StaticAssets.load(dir);
    const res = await createApp(CONFIG, { assets }).request('http://internal.invalid/', {
      method: 'POST',
      headers: { Host: HOST, Origin: 'http://evil.com', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('S1-7: すべての応答に CSP が付く(インラインのスクリプトと外部のスクリプトを許さない)', async () => {
    for (const path of ['/', '/assets/app-abc.js', '/healthz', '/nope', '/api/unknown']) {
      const csp = (await get(path)).headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
      expect(csp, path).toContain("object-src 'none'");
      expect(csp, path).toContain("frame-ancestors 'none'");
    }
  });

  it('S1-7: 403 の応答にも CSP と nosniff が付く', async () => {
    const res = await get('/', { Host: 'evil.com' });
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
