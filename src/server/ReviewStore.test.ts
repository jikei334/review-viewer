/**
 * T2-2: ReviewStore の単体テスト(SPEC §2.1、S2-1 の永続、S2-8、C-6 の土台)
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommentNotFoundError,
  COMMENTS_FILE,
  nextTimestamp,
  parseStoreFile,
  realStoreFs,
  ReviewStore,
  ReviewStoreError,
  StoreClosingError,
  type NewComment,
  type StoreFs,
} from './ReviewStore.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rv-unit-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** テスト用の新しいコメントの内容 */
const SAMPLE: NewComment = {
  path: 'src/a.ts',
  anchor: { startLine: 1, endLine: 2, quote: 'a\nb', docHash: 'f'.repeat(64) },
  body: 'メモ',
  author: 'human',
  type: 'note',
};

/**
 * ID と時刻を注入した ReviewStore を作る
 *
 * @param over 差し替える項目
 * @returns ストア
 */
function makeStore(over: { fs?: StoreFs; times?: string[] } = {}): ReviewStore {
  let n = 0;
  const times = over.times ?? [];
  let t = 0;
  return new ReviewStore({
    dataDir: dir,
    ...(over.fs === undefined ? {} : { fs: over.fs }),
    newId: () => `id-${(n += 1)}`,
    now: () => new Date(times[t++] ?? '2026-10-21T00:00:00.000Z'),
  });
}

/**
 * 保存先のファイル名の一覧
 *
 * @returns 名前の配列(昇順)
 */
function files(): string[] {
  return readdirSync(dir).sort();
}

describe('S2-1: 読み込み', () => {
  it('S2-1: comments.json が無ければ、空で始まる(ファイルは作らない)', async () => {
    const store = makeStore();
    await store.load();
    expect(store.list()).toEqual([]);
    expect(files()).toEqual([]);
  });

  it('S2-1: load() の前に list() / add() するとエラー(既存のコメントを消さないため)', async () => {
    const store = makeStore();
    expect(() => store.list()).toThrow(ReviewStoreError);
    await expect(store.add(SAMPLE)).rejects.toThrow(ReviewStoreError);
    expect(files()).toEqual([]);
  });

  it('S2-1: 保存したコメントは、別のインスタンスで読み込み直しても残る', async () => {
    const a = makeStore();
    await a.load();
    const created = await a.add(SAMPLE);
    const b = makeStore();
    await b.load();
    expect(b.list()).toEqual([created]);
  });

  it.each([
    ['JSON でない', '{broken'],
    ['配列', '[]'],
    ['版番号が違う', JSON.stringify({ version: 2, comments: [] })],
    ['comments が配列でない', JSON.stringify({ version: 1, comments: {} })],
    ['コメントの形が違う', JSON.stringify({ version: 1, comments: [{ id: 1 }] })],
  ])('S2-1: %s の comments.json は、黙って空にせず失敗し、ファイルを書き換えない', async (_label, text) => {
    writeFileSync(join(dir, COMMENTS_FILE), text);
    const store = makeStore();
    await expect(store.load()).rejects.toThrow(ReviewStoreError);
    // 失敗したままの状態で add しても、元のファイルを上書きしない
    await expect(store.add(SAMPLE)).rejects.toThrow(ReviewStoreError);
    expect(readFileSync(join(dir, COMMENTS_FILE), 'utf8')).toBe(text);
  });

  it('C-5: 壊れたファイルのエラーに、ファイルの中身を含めない', async () => {
    writeFileSync(join(dir, COMMENTS_FILE), '{"version":1,"comments":[{"body":"SECRET_BODY_SENTINEL"');
    try {
      await makeStore().load();
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as Error).message).not.toContain('SECRET_BODY_SENTINEL');
    }
  });

  it('S2-1: 読めない(ENOENT 以外)ときは、空にせず失敗する', async () => {
    const failing: StoreFs = {
      ...realStoreFs,
      readFile: () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })),
    };
    await expect(makeStore({ fs: failing }).load()).rejects.toThrow(/読み込めません/);
  });

  it('S2-1: parseStoreFile は正しい形を受け付ける', () => {
    expect(parseStoreFile(JSON.stringify({ version: 1, comments: [] }))).toEqual([]);
  });
});

describe('S2-1: 追加', () => {
  it('S2-1: ID と時刻は注入でき、status は open、replies は空、resolution は null', async () => {
    const store = makeStore({ times: ['2026-10-21T01:02:03.000Z'] });
    await store.load();
    const c = await store.add(SAMPLE);
    expect(c).toEqual({
      id: 'id-1',
      ...SAMPLE,
      status: 'open',
      replies: [],
      resolution: null,
      createdAt: '2026-10-21T01:02:03.000Z',
      updatedAt: '2026-10-21T01:02:03.000Z',
    });
  });

  it('S2-1: 保存ファイルは version と comments を持つ JSON で、一時ファイルは残らない', async () => {
    const store = makeStore();
    await store.load();
    await store.add(SAMPLE);
    expect(files()).toEqual([COMMENTS_FILE]);
    const saved = JSON.parse(readFileSync(join(dir, COMMENTS_FILE), 'utf8')) as { version: number; comments: unknown[] };
    expect(saved.version).toBe(1);
    expect(saved.comments).toHaveLength(1);
  });

  it('S2-1: list() が返す値を変更しても、内部と保存に影響しない', async () => {
    const store = makeStore();
    await store.load();
    await store.add(SAMPLE);
    const list = store.list() as Array<{ body: string }>;
    list[0]!.body = 'tampered';
    list.pop();
    expect(store.list()[0]?.body).toBe('メモ');
  });

  it('S2-1: 同時に呼んでも直列化され、すべて保存され、作成順に並ぶ', async () => {
    const store = makeStore();
    await store.load();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_v, i) => store.add({ ...SAMPLE, body: `c${i}` }))
    );
    expect(results.map((c) => c.id)).toEqual(Array.from({ length: 20 }, (_v, i) => `id-${i + 1}`));
    const reloaded = makeStore();
    await reloaded.load();
    expect(reloaded.list().map((c) => c.body)).toEqual(Array.from({ length: 20 }, (_v, i) => `c${i}`));
    expect(files()).toEqual([COMMENTS_FILE]);
  });

  it('S2-1: 書き込みは重ならない(前の書き込みが終わってから次を始める)', async () => {
    let active = 0;
    let maxActive = 0;
    const slow: StoreFs = {
      ...realStoreFs,
      async writeFileSynced(path, data) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        await realStoreFs.writeFileSynced(path, data);
        active -= 1;
      },
    };
    const store = makeStore({ fs: slow });
    await store.load();
    await Promise.all([store.add(SAMPLE), store.add(SAMPLE), store.add(SAMPLE)]);
    expect(maxActive).toBe(1);
  });
});

describe('S2-8・C-6: 書き込みの失敗', () => {
  it('C-6: 一時ファイルの書き込みに失敗しても、既存の comments.json は変わらず、一時ファイルも残らない', async () => {
    const store = makeStore();
    await store.load();
    await store.add(SAMPLE);
    const before = readFileSync(join(dir, COMMENTS_FILE), 'utf8');

    const failing: StoreFs = {
      ...realStoreFs,
      async writeFileSynced(path, data) {
        // 途中まで書いて失敗した状態を作る
        writeFileSync(path, data.slice(0, 10));
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    };
    const store2 = makeStore({ fs: failing });
    await store2.load();
    await expect(store2.add({ ...SAMPLE, body: '失敗する' })).rejects.toThrow(ReviewStoreError);
    expect(readFileSync(join(dir, COMMENTS_FILE), 'utf8')).toBe(before);
    expect(files()).toEqual([COMMENTS_FILE]);
    // メモリ上にも追加されていない
    expect(store2.list()).toHaveLength(1);
  });

  it('C-6: rename に失敗しても、既存の comments.json は変わらず、一時ファイルは消される', async () => {
    const store = makeStore();
    await store.load();
    await store.add(SAMPLE);
    const before = readFileSync(join(dir, COMMENTS_FILE), 'utf8');
    const failing: StoreFs = {
      ...realStoreFs,
      rename: () => Promise.reject(Object.assign(new Error('x'), { code: 'EIO' })),
    };
    const store2 = makeStore({ fs: failing });
    await store2.load();
    await expect(store2.add(SAMPLE)).rejects.toThrow(/保存できません/);
    expect(readFileSync(join(dir, COMMENTS_FILE), 'utf8')).toBe(before);
    expect(files()).toEqual([COMMENTS_FILE]);
  });

  it('C-6: 失敗した後も、次の書き込みは成功する(キューが詰まらない)', async () => {
    let calls = 0;
    const flaky: StoreFs = {
      ...realStoreFs,
      writeFileSynced: (path, data) => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('first fails')) : realStoreFs.writeFileSynced(path, data);
      },
    };
    const store = makeStore({ fs: flaky });
    await store.load();
    const first = store.add(SAMPLE);
    const second = store.add(SAMPLE);
    await expect(first).rejects.toThrow(ReviewStoreError);
    await expect(second).resolves.toMatchObject({ id: 'id-2' });
    expect(store.list()).toHaveLength(1);
  });

  it('C-5: 保存失敗のエラーに、コメントの本文を含めない', async () => {
    const failing: StoreFs = {
      ...realStoreFs,
      writeFileSynced: () => Promise.reject(new Error('boom')),
    };
    const store = makeStore({ fs: failing });
    await store.load();
    try {
      await store.add({ ...SAMPLE, body: 'BODY_SENTINEL_MUST_NOT_LEAK' });
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as Error).message).not.toContain('BODY_SENTINEL_MUST_NOT_LEAK');
    }
  });

  it('C-6: drain() は、受け付け済みの書き込みがすべて終わってから解決する', async () => {
    const store = makeStore();
    await store.load();
    const pending = [store.add(SAMPLE), store.add(SAMPLE)];
    await store.drain();
    expect(readdirSync(dir)).toEqual([COMMENTS_FILE]);
    expect(JSON.parse(readFileSync(join(dir, COMMENTS_FILE), 'utf8')).comments).toHaveLength(2);
    await Promise.all(pending);
  });

  it('C-6: drain() は、失敗した書き込みがあっても投げない(失敗は呼び出し元へ伝わる)', async () => {
    const failing: StoreFs = { ...realStoreFs, writeFileSynced: () => Promise.reject(new Error('x')) };
    const store = makeStore({ fs: failing });
    await store.load();
    const p = store.add(SAMPLE);
    await expect(store.drain()).resolves.toBeUndefined();
    await expect(p).rejects.toThrow(ReviewStoreError);
  });
});

describe('T2-6: updateStatus / addReply / nextTimestamp(S2-7、S2-8)', () => {
  it('S2-7: updateStatus は status・resolution を置き換え、updatedAt を進めて保存する', async () => {
    const store = makeStore({ times: ['2026-10-21T00:00:00.000Z', '2026-10-21T00:00:05.000Z'] });
    await store.load();
    const c = await store.add(SAMPLE);
    const u = await store.updateStatus(c.id, { status: 'resolved', resolution: '直した' });
    expect(u).toMatchObject({ status: 'resolved', resolution: '直した', body: 'メモ', createdAt: c.createdAt });
    expect(u.updatedAt).toBe('2026-10-21T00:00:05.000Z');
    const reloaded = makeStore();
    await reloaded.load();
    expect(reloaded.list()).toEqual([u]);
  });

  it('S2-7: 同じ値への変更でも updatedAt が進む', async () => {
    const store = makeStore({ times: ['2026-10-21T00:00:00.000Z', '2026-10-21T00:00:01.000Z'] });
    await store.load();
    const c = await store.add(SAMPLE);
    const u = await store.updateStatus(c.id, { status: 'open', resolution: null });
    expect(u.updatedAt > c.updatedAt).toBe(true);
  });

  it('S2-7: 時計が同じ値・過去を返しても、updatedAt は前の値より厳密に後(+1ms)', async () => {
    const same = '2026-10-21T00:00:00.000Z';
    const store = makeStore({ times: [same, same, same, '2026-10-20T00:00:00.000Z'] });
    await store.load();
    const c = await store.add(SAMPLE);
    const u1 = await store.updateStatus(c.id, { status: 'wontfix', resolution: null });
    expect(u1.updatedAt).toBe('2026-10-21T00:00:00.001Z');
    const u2 = await store.addReply(c.id, { author: 'human', body: 'x' });
    expect(u2.updatedAt).toBe('2026-10-21T00:00:00.002Z');
    expect(nextTimestamp(new Date('2026-10-21T00:00:00.000Z'), '2026-10-21T00:00:00.000Z')).toBe('2026-10-21T00:00:00.001Z');
    expect(nextTimestamp(new Date('2026-10-21T00:00:09.000Z'), '2026-10-21T00:00:00.000Z')).toBe('2026-10-21T00:00:09.000Z');
  });

  it('S2-8: addReply は返信を末尾に足し、返信の createdAt とコメントの updatedAt を進める', async () => {
    const store = makeStore({ times: ['2026-10-21T00:00:00.000Z', '2026-10-21T00:00:02.000Z', '2026-10-21T00:00:03.000Z'] });
    await store.load();
    const c = await store.add(SAMPLE);
    await store.addReply(c.id, { author: 'human', body: '1' });
    const u = await store.addReply(c.id, { author: 'ai', body: '2' });
    expect(u.replies.map((r) => [r.author, r.body, r.createdAt])).toEqual([
      ['human', '1', '2026-10-21T00:00:02.000Z'],
      ['ai', '2', '2026-10-21T00:00:03.000Z'],
    ]);
    expect(new Set(u.replies.map((r) => r.id)).size).toBe(2);
    expect(u.updatedAt).toBe('2026-10-21T00:00:03.000Z');
  });

  it('S2-7: 存在しない id は CommentNotFoundError で、何も書かない', async () => {
    const store = makeStore();
    await store.load();
    await store.add(SAMPLE);
    const before = readFileSync(join(dir, COMMENTS_FILE), 'utf8');
    await expect(store.updateStatus('none', { status: 'open', resolution: null })).rejects.toBeInstanceOf(CommentNotFoundError);
    await expect(store.addReply('none', { author: 'human', body: 'x' })).rejects.toBeInstanceOf(CommentNotFoundError);
    expect(readFileSync(join(dir, COMMENTS_FILE), 'utf8')).toBe(before);
    expect(files()).toEqual([COMMENTS_FILE]);
  });

  it('S2-7: 保存に失敗したら、既存ファイルもメモリ上も変わらない(失敗の後は続けて成功できる)', async () => {
    const store0 = makeStore();
    await store0.load();
    const c = await store0.add(SAMPLE);
    const before = readFileSync(join(dir, COMMENTS_FILE), 'utf8');
    let fail = true;
    const flaky: StoreFs = {
      ...realStoreFs,
      rename: (a, b) => (fail ? Promise.reject(new Error('boom')) : realStoreFs.rename(a, b)),
    };
    const store = makeStore({ fs: flaky });
    await store.load();
    await expect(store.updateStatus(c.id, { status: 'resolved', resolution: 'x' })).rejects.toBeInstanceOf(ReviewStoreError);
    await expect(store.addReply(c.id, { author: 'human', body: 'x' })).rejects.toBeInstanceOf(ReviewStoreError);
    expect(readFileSync(join(dir, COMMENTS_FILE), 'utf8')).toBe(before);
    expect(files()).toEqual([COMMENTS_FILE]);
    expect(store.list()).toEqual([c]);
    fail = false;
    expect((await store.updateStatus(c.id, { status: 'resolved', resolution: 'x' })).status).toBe('resolved');
  });

  it('S2-8: 返信 20 件と状態変更を同時に呼んでも、更新が失われない', async () => {
    const store = makeStore();
    await store.load();
    const c = await store.add(SAMPLE);
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => store.addReply(c.id, { author: 'human', body: `r${i}` })),
      store.updateStatus(c.id, { status: 'wontfix', resolution: 'r' }),
    ]);
    const [got] = store.list();
    expect(got?.replies.map((r) => r.body)).toEqual(Array.from({ length: 20 }, (_, i) => `r${i}`));
    expect(got?.status).toBe('wontfix');
    const reloaded = makeStore();
    await reloaded.load();
    expect(reloaded.list()).toEqual(store.list());
  });
});

describe('S2-2 / S2-3 / C-6: 書き込みの完了待ちと終了処理', () => {
  it('S2-3: rename の失敗で、既存の comments.json は無傷で、一時ファイルも残らない', async () => {
    const store = makeStore();
    await store.load();
    await store.add(SAMPLE);
    const before = readFileSync(join(dir, COMMENTS_FILE), 'utf8');
    const failing = makeStore({
      fs: { ...realStoreFs, rename: () => Promise.reject(Object.assign(new Error('x'), { code: 'EIO' })) },
    });
    await failing.load();
    await expect(failing.add(SAMPLE)).rejects.toThrow(ReviewStoreError);
    expect(readFileSync(join(dir, COMMENTS_FILE), 'utf8')).toBe(before);
    expect(files()).toEqual([COMMENTS_FILE]);
  });

  it('S2-3: 書き込みの途中(fsync 前)の失敗でも、既存のファイルは無傷で、メモリも変わらない', async () => {
    const store = makeStore();
    await store.load();
    await store.add(SAMPLE);
    const before = readFileSync(join(dir, COMMENTS_FILE), 'utf8');
    const failing = makeStore({
      fs: {
        ...realStoreFs,
        async writeFileSynced(path, data) {
          await realStoreFs.writeFileSynced(path, data.slice(0, 10));
          throw Object.assign(new Error('x'), { code: 'ENOSPC' });
        },
      },
    });
    await failing.load();
    await expect(failing.add(SAMPLE)).rejects.toThrow(ReviewStoreError);
    expect(readFileSync(join(dir, COMMENTS_FILE), 'utf8')).toBe(before);
    expect(files()).toEqual([COMMENTS_FILE]);
    expect(failing.list()).toHaveLength(1);
  });

  it('S2-2: drain() は、受け付け済みの書き込みがすべて保存されてから解決する', async () => {
    const store = makeStore();
    await store.load();
    const pending = [store.add(SAMPLE), store.add(SAMPLE), store.add(SAMPLE)];
    await store.drain();
    expect(parseStoreFile(readFileSync(join(dir, COMMENTS_FILE), 'utf8'))).toHaveLength(3);
    await Promise.all(pending);
  });

  it('S2-2: 終了処理を始めると、新しい書き込みは StoreClosingError で断り、何も書かない', async () => {
    const store = makeStore();
    await store.load();
    const created = await store.add(SAMPLE);
    store.beginShutdown();
    expect(() => store.add(SAMPLE)).toThrow(StoreClosingError);
    expect(() => store.updateStatus(created.id, { status: 'resolved', resolution: null })).toThrow(StoreClosingError);
    expect(() => store.addReply(created.id, { author: 'human', body: 'x' })).toThrow(StoreClosingError);
    expect(store.list()).toHaveLength(1);
    expect(parseStoreFile(readFileSync(join(dir, COMMENTS_FILE), 'utf8'))).toHaveLength(1);
  });

  it('S2-2: 終了処理を始める前に受け付けた書き込みは、断られず保存される', async () => {
    const store = makeStore();
    await store.load();
    const accepted = store.add(SAMPLE);
    store.beginShutdown();
    await store.drain();
    await expect(accepted).resolves.toMatchObject({ id: 'id-1' });
    expect(parseStoreFile(readFileSync(join(dir, COMMENTS_FILE), 'utf8'))).toHaveLength(1);
    expect(files()).toEqual([COMMENTS_FILE]);
  });

  it('S2-3: 起動時の掃除は、自分の一時ファイルの形だけを消し、comments.json と他のファイルは消さない', async () => {
    const keep = ['other.txt', 'comments.json.bak', 'comments.json.tmp', 'comments.json.1.tmp', 'x.comments.json.1.2.tmp'];
    writeFileSync(join(dir, COMMENTS_FILE), JSON.stringify({ version: 1, comments: [] }));
    for (const name of keep) writeFileSync(join(dir, name), 'keep');
    writeFileSync(join(dir, 'comments.json.123.4.tmp'), 'partial');
    writeFileSync(join(dir, 'comments.json.99999.1.tmp'), '{"ver');
    const store = makeStore();
    await expect(store.cleanupTempFiles()).resolves.toEqual({ removed: 2, failed: 0 });
    expect(files()).toEqual([COMMENTS_FILE, ...keep].sort());
    expect(readFileSync(join(dir, COMMENTS_FILE), 'utf8')).toContain('"version":1');
  });

  it('S2-3: 掃除で1件消せなくても止まらず、失敗の数を返す。一覧できなければ失敗する', async () => {
    writeFileSync(join(dir, 'comments.json.1.1.tmp'), 'a');
    writeFileSync(join(dir, 'comments.json.1.2.tmp'), 'b');
    const partial = makeStore({
      fs: {
        ...realStoreFs,
        unlink: (p) =>
          p.endsWith('1.1.tmp') ? Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) : realStoreFs.unlink(p),
      },
    });
    await expect(partial.cleanupTempFiles()).resolves.toEqual({ removed: 1, failed: 1 });
    const noList = makeStore({ fs: { ...realStoreFs, listDir: () => Promise.reject(new Error('x')) } });
    await expect(noList.cleanupTempFiles()).rejects.toThrow(ReviewStoreError);
  });
});
