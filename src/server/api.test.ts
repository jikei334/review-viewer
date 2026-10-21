/**
 * T1-2: Web API(/api/reports、/api/tree、/api/file)と、エラー処理(onError)の単体テスト
 * (S1-1、S1-4、S1-5、S1-6、S1-7 の Content-Type、C-1、C-5)
 *
 * セキュリティ基準の回帰テスト。機能追加のときに外さない。
 * Hono アプリを、TCP を使わずに `app.request()` で直接呼ぶ。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTempRepo, type TempRepo } from './__fixtures__/temp-repo.js';
import { createApp, summarizeErrorForLog, type AppDeps } from './app.js';

const HOST = '127.0.0.1:3000';
const GUARD = {
  allowedHosts: ['127.0.0.1:3000', 'localhost:3000'],
  allowedOrigins: ['http://127.0.0.1:3000', 'http://localhost:3000'],
};

/** 秘密ファイルに見えるダミーの中身。応答にもログにも出てはいけない */
const SECRET_SENTINEL = 'UNIT_API_DUMMY_SECRET_SENTINEL_NOT_A_REAL_SECRET';
/** リポジトリの外のファイルの中身。応答にもログにも出てはいけない */
const OUTSIDE_SENTINEL = 'UNIT_API_OUTSIDE_SENTINEL_MUST_NOT_LEAK';
/** `.gitignore` の対象のファイルの中身。応答にもログにも出てはいけない */
const IGNORED_SENTINEL = 'UNIT_API_IGNORED_SENTINEL_MUST_NOT_LEAK';

let repo: TempRepo;
/** ログに出た行(テストごとに空にする) */
const logLines: string[] = [];

/**
 * アプリへ GET を送る
 *
 * @param pathAndQuery パスとクエリ(エンコードは呼び出し側が行う。そのまま送る)
 * @param options Host ヘッダと、差し替える依存
 * @returns 応答
 */
async function get(
  pathAndQuery: string,
  options: { host?: string; deps?: AppDeps; repoDir?: string } = {}
): Promise<Response> {
  const app = createApp(
    { ...GUARD, repoDir: options.repoDir ?? repo.repoDir },
    { log: (line) => logLines.push(line), ...options.deps }
  );
  return app.request(`http://internal.invalid${pathAndQuery}`, { headers: { Host: options.host ?? HOST } });
}

beforeAll(async () => {
  repo = await createTempRepo();
  await repo.write('src/example.ts', 'export function increment(n: number): number {\n  return n + 1;\n}\n');
  await repo.write('subdir/normal.ts', 'export const normal = true;\n');
  await repo.write('reports/2026-10-12-feature.md', '# feature\n');
  await repo.write('reports/2026-09-01-initial.md', '# initial\n');
  await repo.write('reports/2026-08-02-xss.md', '# <script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n');
  await repo.setMtime('reports/2026-10-12-feature.md', new Date('2026-10-12T00:00:00Z'));
  await repo.setMtime('reports/2026-09-01-initial.md', new Date('2026-09-01T00:00:00Z'));
  await repo.setMtime('reports/2026-08-02-xss.md', new Date('2026-08-02T00:00:00Z'));

  await repo.write('.env', `DUMMY=${SECRET_SENTINEL}\n`);
  await repo.write('subdir/.env', `DUMMY=${SECRET_SENTINEL}\n`);
  await repo.write('.git/config', `# ${SECRET_SENTINEL}\n`);
  await repo.write('server.key', `${SECRET_SENTINEL}\n`);
  await repo.write('.gitignore', '*.log\nbuild-out/\nreports/2026-12-31-ignored.md\n');
  await repo.write('debug.log', `${IGNORED_SENTINEL}\n`);
  await repo.write('build-out/artifact.txt', `${IGNORED_SENTINEL}\n`);
  await repo.write('reports/2026-12-31-ignored.md', `# ${IGNORED_SENTINEL}\n`);

  const outside = await repo.writeOutside('outside-secret.txt', `${OUTSIDE_SENTINEL}\n`);
  await repo.writeOutside('dir/inner.txt', `${OUTSIDE_SENTINEL}\n`);
  await repo.link(outside, 'link-abs-file.txt');
  await repo.link('../outside/dir', 'link-dir');
  await repo.link('.env', 'notes-link.txt');

  await repo.write('large.txt', 'UNIT_API_LARGE_MARKER\n'.repeat(60_000)); // 約 1.3MB
  await repo.write('binary-data.txt', Buffer.from([0x89, 0x50, 0x00, 0x55, 0x4e, 0x49, 0x54, 0xff, 0x00]));
});

afterAll(async () => {
  await repo.cleanup();
});

afterEach(() => {
  logLines.length = 0;
  vi.restoreAllMocks();
});

/**
 * 応答が JSON で、ブラウザに HTML として解釈されないことを確かめる
 *
 * @param res 応答
 * @returns なし(満たさなければ、その場でテストが失敗する)
 */
function expectJsonResponse(res: Response): void {
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

describe('S1-1: GET /api/reports', () => {
  it('S1-1: reports/*.md を、新しい順に、JSON で返す(.gitignore の対象は出さない)', async () => {
    const res = await get('/api/reports');
    expect(res.status).toBe(200);
    expectJsonResponse(res);
    expect(await res.json()).toEqual({
      reports: [
        { name: '2026-10-12-feature.md', path: 'reports/2026-10-12-feature.md', modifiedAt: '2026-10-12T00:00:00.000Z' },
        { name: '2026-09-01-initial.md', path: 'reports/2026-09-01-initial.md', modifiedAt: '2026-09-01T00:00:00.000Z' },
        { name: '2026-08-02-xss.md', path: 'reports/2026-08-02-xss.md', modifiedAt: '2026-08-02T00:00:00.000Z' },
      ],
    });
  });
});

describe('T1-2: GET /api/tree', () => {
  it.each(['/api/tree', '/api/tree?path=', '/api/tree?path=.', '/api/tree?path=./'])(
    'T1-2: path が省略・空(%s)なら、リポジトリのルートの一覧を返す(SPEC §2.2)',
    async (url) => {
      const res = await get(url);
      expect(res.status).toBe(200);
      expectJsonResponse(res);
      expect(await res.json()).toEqual({
        path: '',
        entries: [
          { name: 'reports', path: 'reports', type: 'directory' },
          { name: 'src', path: 'src', type: 'directory' },
          { name: 'subdir', path: 'subdir', type: 'directory' },
          { name: '.gitignore', path: '.gitignore', type: 'file' },
          { name: 'binary-data.txt', path: 'binary-data.txt', type: 'file' },
          { name: 'large.txt', path: 'large.txt', type: 'file' },
        ],
      });
    }
  );

  it('T1-2: サブディレクトリの一覧を返す(秘密ファイルは出さない)', async () => {
    const res = await get('/api/tree?path=subdir');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: 'subdir',
      entries: [{ name: 'normal.ts', path: 'subdir/normal.ts', type: 'file' }],
    });
  });
});

describe('T1-2: GET /api/file', () => {
  it('T1-2: テキストファイルの本文を、JSON の文字列として返す', async () => {
    const res = await get('/api/file?path=src/example.ts');
    expect(res.status).toBe(200);
    expectJsonResponse(res);
    expect(await res.json()).toEqual({
      path: 'src/example.ts',
      size: 65,
      kind: 'text',
      content: 'export function increment(n: number): number {\n  return n + 1;\n}\n',
    });
  });

  it('S1-7: HTML を含む Markdown も、JSON として返す(HTML として解釈される Content-Type にしない)', async () => {
    const res = await get('/api/file?path=reports%2F2026-08-02-xss.md');
    expect(res.status).toBe(200);
    expectJsonResponse(res);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain('<script>alert(1)</script>');
  });

  it('S1-6: 巨大ファイルは、本文を返さず、その旨を返す', async () => {
    const res = await get('/api/file?path=large.txt');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ path: 'large.txt', size: 1_320_000, kind: 'too_large', maxBytes: 1_048_576 });
    expect(text).not.toContain('UNIT_API_LARGE_MARKER');
  });

  it('S1-6: バイナリ(拡張子は .txt)は、本文を返さず、その旨を返す', async () => {
    const res = await get('/api/file?path=binary-data.txt');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ path: 'binary-data.txt', size: 9, kind: 'binary' });
    expect(text).not.toContain('UNIT');
  });

  it('S1-6: 巨大・バイナリへの応答は、存在しないファイルへの応答と区別できる', async () => {
    const missing = await get('/api/file?path=no-such-large.txt');
    expect(missing.status).toBe(404);
    expect((await get('/api/file?path=large.txt')).status).toBe(200);
  });
});

describe('S1-4 / S1-5: API は、拒否対象を、存在しないパスと同じ応答で拒否する', () => {
  /** 存在しないパスへの応答(これと同じであること) */
  const NOT_FOUND_BODY = '{"error":"not_found"}';

  it.each([
    ['存在しないファイル', '/api/file?path=no-such-file.txt'],
    ['秘密ファイル', '/api/file?path=.env'],
    ['秘密ファイル(サブディレクトリ)', '/api/file?path=subdir/.env'],
    ['秘密ファイル(存在しない)', '/api/file?path=no-such-dir/.env'],
    ['秘密ファイル(./ と重複スラッシュ)', '/api/file?path=.//subdir//.env'],
    ['秘密ファイル(末尾のスラッシュ)', '/api/file?path=.env/'],
    ['秘密ファイル(大文字)', '/api/file?path=.ENV'],
    ['秘密ファイル(エンコードされた .)', '/api/file?path=%2eenv'],
    ['.git の配下', '/api/file?path=.git/config'],
    ['.git の配下(エンコードされた /)', '/api/file?path=.git%2fconfig'],
    ['.git の配下(大文字)', '/api/file?path=.GIT/config'],
    ['鍵のファイル', '/api/file?path=server.key'],
    ['.gitignore の対象', '/api/file?path=debug.log'],
    ['.gitignore の対象のディレクトリの配下', '/api/file?path=build-out/artifact.txt'],
    ['外を指すリンク', '/api/file?path=link-abs-file.txt'],
    ['外を指すディレクトリのリンクの配下', '/api/file?path=link-dir/inner.txt'],
    ['秘密ファイルを指すリンク', '/api/file?path=notes-link.txt'],
    ['二重エンコード(その名前のファイルは無い)', '/api/file?path=%252e%252e%252foutside%252foutside-secret.txt'],
    ['....//', '/api/file?path=....//outside/outside-secret.txt'],
    ['ディレクトリを /api/file で指定', '/api/file?path=src'],
    ['path の省略', '/api/file'],
    ['存在しないディレクトリ', '/api/tree?path=no-such-dir'],
    ['.git', '/api/tree?path=.git'],
    ['.git/', '/api/tree?path=.git/'],
    ['.gitignore の対象のディレクトリ', '/api/tree?path=build-out'],
    ['外を指すディレクトリのリンク', '/api/tree?path=link-dir'],
    ['ファイルを /api/tree で指定', '/api/tree?path=src/example.ts'],
  ])('S1-4 / S1-5: %s(%s)は 404 で、応答が存在しないパスと完全に同じ', async (_label, url) => {
    const res = await get(url);
    expect(res.status).toBe(404);
    expectJsonResponse(res);
    expect(await res.text()).toBe(NOT_FOUND_BODY);
  });

  it.each([
    ['../', '/api/file?path=../outside/outside-secret.txt'],
    ['途中の ../', '/api/file?path=src/../../outside/outside-secret.txt'],
    ['エンコードされた ../', '/api/file?path=%2e%2e%2foutside%2foutside-secret.txt'],
    ['..%2f', '/api/file?path=..%2foutside%2foutside-secret.txt'],
    ['大文字のエンコード', '/api/file?path=%2E%2E/outside/outside-secret.txt'],
    ['バックスラッシュ', '/api/file?path=..%5coutside%5coutside-secret.txt'],
    ['NUL', '/api/file?path=../outside/outside-secret.txt%00.md'],
    ['NUL(秘密ファイル)', '/api/file?path=.env%00.md'],
    ['絶対パス', '/api/file?path=/etc/passwd'],
    ['絶対パス(エンコード)', '/api/file?path=%2Fetc%2Fpasswd'],
    ['絶対パス(//)', '/api/file?path=//etc/passwd'],
    ['`..` で秘密ファイルへ', '/api/file?path=src/../.env'],
    ['`..` で秘密ファイルへ(.git 経由)', '/api/file?path=.git/../.env'],
    ['path が2つ', '/api/file?path=src/example.ts&path=.env'],
    ['..', '/api/tree?path=..'],
    ['エンコードされた ..', '/api/tree?path=%2e%2e'],
    ['../outside/dir', '/api/tree?path=..%2foutside%2fdir'],
    ['絶対パス', '/api/tree?path=/etc'],
  ])('S1-4: 形式が正しくないパス(%s: %s)は 400', async (_label, url) => {
    const res = await get(url);
    expect(res.status).toBe(400);
    expectJsonResponse(res);
    expect(await res.text()).toBe('{"error":"invalid_path"}');
  });

  it('S1-4: リポジトリの外のファイルを、絶対パスで指定しても拒否する', async () => {
    const res = await get(`/api/file?path=${encodeURIComponent(`${repo.outsideDir}/outside-secret.txt`)}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('{"error":"invalid_path"}');
  });

  it('C-5: 拒否の応答とログに、秘密ファイルの中身、外のファイルの中身、実体のパスが出ない', async () => {
    const urls = [
      '/api/file?path=.env',
      '/api/file?path=notes-link.txt',
      '/api/file?path=link-abs-file.txt',
      '/api/file?path=debug.log',
      '/api/file?path=../outside/outside-secret.txt',
      '/api/tree',
      '/api/tree?path=subdir',
      '/api/tree?path=link-dir',
      '/api/tree?path=.git',
      '/api/reports',
    ];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bodies: string[] = [];
    for (const url of urls) bodies.push(await (await get(url)).text());

    const all = [...bodies, ...logLines].join('\n');
    expect(all).not.toContain(SECRET_SENTINEL);
    expect(all).not.toContain(OUTSIDE_SENTINEL);
    expect(all).not.toContain(IGNORED_SENTINEL);
    expect(all).not.toContain(repo.baseDir);
    // 拒否は、想定どおりの動作なので、ログにも出さない(拒否した名前をログに残さない)
    expect(logLines).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('C-1: API にも Host の検証が掛かる', () => {
  it.each(['/api/reports', '/api/tree', '/api/file?path=src/example.ts'])(
    'C-1: GET %s は、Host が許可リスト外なら 403 で、業務ロジックを呼ばない',
    async (url) => {
      const service = {
        listReports: vi.fn(),
        listTree: vi.fn(),
        getFile: vi.fn(),
        createComment: vi.fn(),
        listComments: vi.fn(),
      };
      const res = await get(url, { host: 'evil.com', deps: { service } });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('increment');
      expect(service.listReports).not.toHaveBeenCalled();
      expect(service.listTree).not.toHaveBeenCalled();
      expect(service.getFile).not.toHaveBeenCalled();
    }
  );
});

describe('C-5: onError は、ログと応答に出す内容を絞る', () => {
  /** 例外のメッセージに仕込む、出てはいけない文字列 */
  const LEAK = 'UNIT_ONERROR_SENTINEL_MUST_NOT_LEAK';

  /**
   * getFile が、指定したエラーを投げる業務ロジックを作る
   *
   * @param err 投げるエラー
   * @returns 差し替え用の業務ロジック
   */
  function failingService(err: unknown): NonNullable<AppDeps['service']> {
    return {
      listReports: () => Promise.reject(err),
      listTree: () => Promise.reject(err),
      getFile: () => Promise.reject(err),
      createComment: () => Promise.reject(err),
      listComments: () => {
        throw err;
      },
    };
  }

  it('C-5: 想定外の例外は 500。応答は固定の JSON で、メッセージ・パス・スタックを含まない', async () => {
    // Node.js のファイル操作のエラーと同じ形(メッセージに実体のパスが入る)
    const err = Object.assign(new Error(`EIO: i/o error, open '/outside/${LEAK}/id_rsa' DUMMY=${LEAK}`), {
      code: 'EIO',
      path: `/outside/${LEAK}/id_rsa`,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await get(`/api/file?path=src/${LEAK}.ts`, { deps: { service: failingService(err) } });

    expect(res.status).toBe(500);
    expectJsonResponse(res);
    expect(await res.text()).toBe('{"error":"internal_error"}');
    // Hono の既定の onError(console.error に例外をそのまま出す)を使っていない
    expect(consoleError).not.toHaveBeenCalled();
    expect(logLines).toEqual(['Review Viewer: リクエストの処理に失敗しました: GET /api/file: Error (code=EIO)']);
  });

  it.each(['/api/reports', '/api/tree?path=src', '/api/file?path=src/example.ts'])(
    'C-5: GET %s で例外が起きても、ログにクエリ(指定されたパス)とメッセージを出さない',
    async (url) => {
      const res = await get(`${url}${url.includes('?') ? '&' : '?'}x=${LEAK}`, {
        deps: { service: failingService(new TypeError(`bad ${LEAK}`)) },
      });
      expect(res.status).toBe(500);
      expect(logLines).toHaveLength(1);
      expect(logLines[0]).not.toContain(LEAK);
      expect(logLines[0]).not.toContain('src');
      expect(logLines[0]).toContain('TypeError');
    }
  );

  it('C-5: Error でない値が投げられても、その中身をログと応答に出さない', async () => {
    const res = await get('/api/reports', { deps: { service: failingService(`string ${LEAK}`) } });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal_error"}');
    // 握りつぶさずに記録はするが、投げられた値の中身は出さない
    expect(logLines).toEqual(['Review Viewer: リクエストの処理に失敗しました: GET /api/reports: NonErrorThrownError']);
  });

  it('C-5: リポジトリのディレクトリが無いときは 500。ログにそのパスを出さない', async () => {
    const res = await get('/api/tree', { repoDir: `${repo.baseDir}/NO-SUCH-REPO-DIR` });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal_error"}');
    expect(logLines).toEqual([
      'Review Viewer: リクエストの処理に失敗しました: GET /api/tree: RepoUnavailableError (cause=ENOENT)',
    ]);
  });

  it('C-5: 存在しないルートは 404 で、ログを出さない', async () => {
    const res = await get(`/no-such-route/${LEAK}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(LEAK);
    expect(logLines).toEqual([]);
  });
});

describe('C-5: summarizeErrorForLog', () => {
  it('C-5: エラーの名前と、エラーコードだけを出す(メッセージとスタックは出さない)', () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, open '/repo/.env'"), { code: 'ENOENT' });
    expect(summarizeErrorForLog(err)).toBe('Error (code=ENOENT)');
    expect(summarizeErrorForLog(new RangeError('SECRET in message'))).toBe('RangeError');
  });

  it('C-5: 原因(cause)のエラーコードも出す', () => {
    const cause = Object.assign(new Error('x'), { code: 'EACCES' });
    expect(summarizeErrorForLog(new Error('wrapped', { cause }))).toBe('Error (cause=EACCES)');
  });

  it('C-5: 名前やコードに想定外の文字列が入っていたら、出さない(ログへの混入を防ぐ)', () => {
    const err = new Error('x');
    err.name = 'Evil\nReview Viewer: 偽のログ行 SECRET';
    Object.assign(err, { code: 'secret value with spaces' });
    expect(summarizeErrorForLog(err)).toBe('Error');
    expect(summarizeErrorForLog(Object.assign(new Error('x'), { code: 42 }))).toBe('Error');
  });

  it('C-5: Error でない値は、中身を出さない', () => {
    expect(summarizeErrorForLog('SECRET string')).toBe('Error');
    expect(summarizeErrorForLog(null)).toBe('Error');
    expect(summarizeErrorForLog(undefined)).toBe('Error');
    expect(summarizeErrorForLog({ code: 'EIO', message: 'SECRET' })).toBe('Error (code=EIO)');
  });
});
