/**
 * T2-3: ReviewService のコメント作成・取得の単体テスト(S2-1、S2-4)
 *
 * フィクスチャのリポジトリ(RepoReader)と、一時ディレクトリの ReviewStore を使う。
 * ID と時刻は注入する。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRepo, type TempRepo } from './__fixtures__/temp-repo.js';
import { hashContent } from './comment-anchor.js';
import { InputError, type CreateCommentInput } from './comment-input.js';
import { CommentNotFoundError } from './ReviewStore.js';
import { RepoAccessError } from './path-policy.js';
import { RepoReader } from './RepoReader.js';
import { ReviewService } from './ReviewService.js';
import { ReviewStore } from './ReviewStore.js';

const EXAMPLE = 'line1\nline2\nline3\n';
const SECRET = 'UNIT_SERVICE_SECRET_SENTINEL';

let repo: TempRepo;
let dataDir = '';
let store: ReviewStore;
let service: ReviewService;
let readFileSpy: ReturnType<typeof vi.fn>;
let clock = 0;

beforeAll(async () => {
  repo = await createTempRepo();
  await repo.write('src/example.ts', EXAMPLE);
  await repo.write('crlf.txt', 'a\r\nb\r\n');
  await repo.write('empty.txt', '');
  await repo.write('.env', `${SECRET}\n`);
  await repo.write('large.txt', 'x'.repeat(99).concat('\n').repeat(11_000));
  await repo.write('image.bin', Buffer.from([0x89, 0x00, 0x01]));
  const outside = await repo.writeOutside('secret.txt', `${SECRET}\n`);
  await repo.link(outside, 'link-out.txt');
});

afterAll(async () => {
  await repo.cleanup();
});

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rv-unit-svc-'));
  clock = 0;
  let n = 0;
  store = new ReviewStore({
    dataDir,
    newId: () => `c${(n += 1)}`,
    now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, clock++)),
  });
  await store.load();
  const reader = new RepoReader({ repoDir: repo.repoDir });
  readFileSpy = vi.fn((path: string) => reader.readFile(path));
  service = new ReviewService({
    repoReader: { listDirectory: (p) => reader.listDirectory(p), readFile: readFileSpy as RepoReader['readFile'] },
    store,
  });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * 作成の入力を作る
 *
 * @param over 上書きする項目
 * @returns 入力
 */
function input(over: Partial<CreateCommentInput> = {}): CreateCommentInput {
  return { path: 'src/example.ts', startLine: 1, endLine: 2, body: 'メモ', type: 'note', ...over };
}

describe('S2-1: createComment', () => {
  it('S2-1: quote と docHash をサーバーが作り、author は引数のとおり、status は open', async () => {
    const c = await service.createComment(input({ type: 'instruction' }), 'human');
    expect(c).toEqual({
      id: 'c1',
      path: 'src/example.ts',
      anchor: { startLine: 1, endLine: 2, quote: 'line1\nline2', docHash: hashContent(EXAMPLE) },
      body: 'メモ',
      author: 'human',
      type: 'instruction',
      status: 'open',
      replies: [],
      resolution: null,
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    });
  });

  it('S2-1: author を引数で決められる(MCP 用: ai)', async () => {
    expect((await service.createComment(input(), 'ai')).author).toBe('ai');
  });

  it('S2-1: 最終行までは可、その次の行は InputError', async () => {
    await expect(service.createComment(input({ startLine: 3, endLine: 3 }), 'human')).resolves.toBeDefined();
    await expect(service.createComment(input({ startLine: 3, endLine: 4 }), 'human')).rejects.toThrow(InputError);
    expect(service.listComments()).toHaveLength(1);
  });

  it('S2-1: CRLF のファイルの quote に \\r が含まれない', async () => {
    const c = await service.createComment(input({ path: 'crlf.txt', startLine: 1, endLine: 2 }), 'human');
    expect(c.anchor.quote).toBe('a\nb');
  });

  it('S2-1: 空のファイルには、どの行範囲でも InputError', async () => {
    await expect(service.createComment(input({ path: 'empty.txt', startLine: 1, endLine: 1 }), 'human')).rejects.toThrow(
      InputError
    );
  });

  it.each(['large.txt', 'image.bin'])('S2-1: 巨大・バイナリ(%s)は InputError で、保存しない', async (path) => {
    await expect(service.createComment(input({ path }), 'human')).rejects.toThrow(InputError);
    expect(service.listComments()).toEqual([]);
  });

  it('S2-4: 作成時のパス検証は RepoReader に任せる(存在しない・秘密・外を指すリンク・ディレクトリは RepoAccessError)', async () => {
    for (const path of ['no/such.ts', '.env', 'link-out.txt', 'src']) {
      const err = await service.createComment(input({ path }), 'human').catch((e: unknown) => e);
      expect(err, path).toBeInstanceOf(RepoAccessError);
      expect((err as RepoAccessError).code, path).toBe('not_found');
    }
    expect(service.listComments()).toEqual([]);
    expect(readFileSpy).toHaveBeenCalledTimes(4);
  });

  it('C-5: 拒否・失敗のエラーに、秘密ファイルの中身を含めない', async () => {
    const err = await service.createComment(input({ path: '.env' }), 'human').catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(SECRET);
  });
});

describe('S2-1・S2-4: listComments', () => {
  it('S2-1: 作成順(同時刻は作成順)で返る', async () => {
    store = new ReviewStore({ dataDir, newId: (() => { let n = 0; return () => `s${(n += 1)}`; })(), now: () => new Date('2026-10-21T00:00:00.000Z') });
    await store.load();
    const reader = new RepoReader({ repoDir: repo.repoDir });
    const same = new ReviewService({ repoReader: reader, store });
    await same.createComment(input({ body: 'one' }), 'human');
    await same.createComment(input({ body: 'two' }), 'human');
    await same.createComment(input({ body: 'three' }), 'human');
    expect(same.listComments().map((c) => c.body)).toEqual(['one', 'two', 'three']);
  });

  it('S2-1: createdAt の昇順に並べ替える(保存順が違っていても)', async () => {
    const fake = {
      list: () => [
        { id: 'late', createdAt: '2026-10-21T00:00:09.000Z' },
        { id: 'early', createdAt: '2026-10-21T00:00:01.000Z' },
      ],
      add: vi.fn(),
    };
    const s = new ReviewService({
      repoReader: { listDirectory: vi.fn(), readFile: vi.fn() },
      store: fake as unknown as ReviewStore,
    });
    expect(s.listComments().map((c) => c.id)).toEqual(['early', 'late']);
  });

  it('S2-1: path・status・type は、指定したものだけで絞る', async () => {
    await service.createComment(input({ body: 'a', type: 'note' }), 'human');
    await service.createComment(input({ body: 'b', type: 'instruction' }), 'human');
    await service.createComment(input({ path: 'crlf.txt', startLine: 1, endLine: 1, body: 'c', type: 'instruction' }), 'ai');
    const bodies = (f: Parameters<ReviewService['listComments']>[0]): string[] =>
      service.listComments(f).map((c) => c.body);
    expect(bodies({})).toEqual(['a', 'b', 'c']);
    expect(bodies({ path: 'src/example.ts' })).toEqual(['a', 'b']);
    expect(bodies({ type: 'instruction' })).toEqual(['b', 'c']);
    expect(bodies({ status: 'open' })).toEqual(['a', 'b', 'c']);
    expect(bodies({ status: 'resolved' })).toEqual([]);
    expect(bodies({ path: 'src/example.ts', type: 'instruction', status: 'open' })).toEqual(['b']);
  });

  it('S2-4: path 絞り込みは RepoReader を呼ばず、存在しない・拒否対象のパスも空の一覧になる', async () => {
    await service.createComment(input(), 'human');
    readFileSpy.mockClear();
    const listDirectory = vi.fn();
    const probe = new ReviewService({ repoReader: { listDirectory, readFile: readFileSpy as RepoReader['readFile'] }, store });
    for (const path of ['no/such.ts', '.env', 'link-out.txt', '.git/config', 'src']) {
      expect(probe.listComments({ path }), path).toEqual([]);
    }
    expect(probe.listComments({ path: 'src/example.ts' })).toHaveLength(1);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it('S2-1: 返した配列を変更しても、保存内容に影響しない', async () => {
    await service.createComment(input(), 'human');
    service.listComments().pop();
    expect(service.listComments()).toHaveLength(1);
  });
});

describe('T2-6: updateComment / addReply(S2-7、S2-8)', () => {
  it('S2-7: updateComment は status と resolution を変え、updatedAt を進める(時刻は注入)', async () => {
    const c = await service.createComment(input(), 'human');
    const u = await service.updateComment(c.id, { status: 'resolved', resolution: '直した' });
    expect(u).toMatchObject({ id: c.id, status: 'resolved', resolution: '直した', body: c.body });
    expect(u.updatedAt > c.updatedAt).toBe(true);
    expect(service.listComments()[0]).toEqual(u);
    const again = await service.updateComment(c.id, { status: 'open', resolution: null });
    expect(again).toMatchObject({ status: 'open', resolution: null });
    expect(again.updatedAt > u.updatedAt).toBe(true);
  });

  it('S2-8: addReply は作者を呼び出し側の値にし、コメントの updatedAt を進める', async () => {
    const c = await service.createComment(input(), 'human');
    const r1 = await service.addReply(c.id, { body: '返信1' }, 'human');
    const r2 = await service.addReply(c.id, { body: '返信2' }, 'ai');
    expect(r2.replies.map((r) => [r.author, r.body])).toEqual([
      ['human', '返信1'],
      ['ai', '返信2'],
    ]);
    expect(r1.updatedAt > c.updatedAt).toBe(true);
    expect(r2.updatedAt > r1.updatedAt).toBe(true);
    expect(r2.replies[0]?.createdAt).toBe(r1.updatedAt);
  });

  it('S2-7: 存在しない id は CommentNotFoundError(assertCommentExists も)', async () => {
    await expect(service.updateComment('none', { status: 'open', resolution: null })).rejects.toBeInstanceOf(CommentNotFoundError);
    await expect(service.addReply('none', { body: 'x' }, 'human')).rejects.toBeInstanceOf(CommentNotFoundError);
    expect(() => service.assertCommentExists('none')).toThrow(CommentNotFoundError);
    const c = await service.createComment(input(), 'human');
    expect(() => service.assertCommentExists(c.id)).not.toThrow();
  });
});
