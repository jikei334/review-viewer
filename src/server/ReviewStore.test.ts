/**
 * T2-2: ReviewStore の単体テスト(SPEC §2.1、S2-1 の永続、S2-8、C-6 の土台)
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMENTS_FILE,
  parseStoreFile,
  realStoreFs,
  ReviewStore,
  ReviewStoreError,
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
