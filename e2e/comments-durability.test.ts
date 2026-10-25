/**
 * e2e コメント保存の堅牢性テスト(ステージ2 / B3)
 * 対象基準: S2-2(同時リクエストでデータが壊れない・失われない)、
 *           S2-3(書き込み中に落ちても comments.json が壊れない)、
 *           C-6(書き込みの途中で SIGTERM / SIGINT を受けても壊れず、5 秒以内に終了コード 0)
 *
 * SPEC §2.1(保存は一時ファイル + rename、書くのは 1 プロセスだけ)、§2.2、§2.5、§3 C-5・C-6、§5 だけを根拠とする。
 * src/ は読まない。comments.json の中身の形は SPEC に無いので、「正しい JSON として読める」ことまでを確かめ、
 * 内容は API 経由で確かめる。
 *
 * 確率的なテストなので、次の方針で偶然の合否を避ける。
 * - 成功(201)の応答を受け取った書き込みだけを「保存されているべきもの」として数える。
 *   応答を受け取れなかった書き込み(SIGKILL 直前など)は、あっても無くても合格とする(SPEC が決めていない)
 * - 落とすタイミングは、「成功の応答が実際に返り始めてから」にする(固定時間の sleep だけに頼らない)
 *
 * 追加時間の目安(上限): S2-2 約 5 秒、S2-3 約 25 秒(上限 60 秒)、C-6 約 10 秒。ループ回数は下の定数で固定。
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commentsOf, getComments, jsonOf, patchComment, postComment, postReply, type JsonObject } from './helpers/comments.js';
import { waitUntil } from './helpers/http.js';
import { startTestServer, stopIfStarted, type TestServer } from './helpers/server.js';

const EXAMPLE = 'src/example.ts';
const DUMMY_TOKEN = 'E2E_DUMMY_TOKEN_NOT_A_REAL_SECRET_S2_B3';
const SECRET_SENTINEL = 'E2E_B3_SECRET_SENTINEL_MUST_NOT_LEAK';

/** S2-2: 同時に作成する件数 */
const CONCURRENT_CREATES = 50;
/** S2-2: 同じコメントへ同時に付ける返信の件数 */
const CONCURRENT_REPLIES = 20;
/** S2-3: 落として再起動する回数の上限 */
const CRASH_ROUNDS = 10;
/** S2-3 / C-6: 事前に作る大きめのコメント数と、1 件あたりの本文の大きさ(バイト) */
const SEED_COMMENTS = 150;
const SEED_BODY_BYTES = 4_000;
/** 書き込みを続ける同時ワーカー数 */
const WRITERS = 6;

/**
 * 本文用の、指定した大きさの埋め草文字列を作る
 * @param bytes 文字数(ASCII なのでバイト数と同じ)
 * @returns 埋め草
 */
function pad(bytes: number): string {
  return 'x'.repeat(bytes);
}

/**
 * コメントを 1 件作る(201 を期待する)
 * @param server 接続先
 * @param body 本文
 * @returns 作成された Comment(JSON)
 */
async function create(server: TestServer, body: string): Promise<JsonObject> {
  const res = await postComment(server, { path: EXAMPLE, startLine: 1, endLine: 1, body, type: 'note' });
  expect(res.status, res.text.slice(0, 300)).toBe(201);
  return jsonOf(res);
}

/**
 * 現在の全コメントを API で取得する
 * @param server 接続先
 * @returns コメントの配列
 */
async function listAll(server: TestServer): Promise<JsonObject[]> {
  const res = await getComments(server);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return commentsOf(res);
}

/**
 * comments.json を読み、JSON として解析できることを確かめる(中身の形は確かめない)
 * @param server 対象サーバー
 * @returns なし
 */
async function expectCommentsFileIsValidJson(server: TestServer): Promise<void> {
  const text = await readFile(join(server.dataDir, 'comments.json'), 'utf8');
  expect(() => JSON.parse(text), 'comments.json が正しい JSON として読めない').not.toThrow();
}

/**
 * 大きめの comments.json になるよう、API でコメントを作る(5 件ずつ並行)
 * @param server 接続先
 * @returns なし
 */
async function seed(server: TestServer): Promise<void> {
  for (let i = 0; i < SEED_COMMENTS; i += 5) {
    await Promise.all(
      Array.from({ length: 5 }, (_, k) => create(server, `seed-${i + k}-${pad(SEED_BODY_BYTES)}`))
    );
  }
}

/** 書き込みワーカー群の状態 */
interface Writers {
  /** 201 を受け取った書き込み(本文 → ID) */
  acked: Map<string, string>;
  /** 201 以外の応答を受け取った書き込みのステータス */
  others: number[];
  /** 書き込みを止めるよう合図する */
  stop: () => void;
  /** 全ワーカーが終わるのを待つ */
  done: Promise<void>;
}

/**
 * 書き込み(コメント作成)を続けるワーカーを始める。
 * 201 以外の応答や接続の失敗(サーバーが落ちた、終了処理で閉じた)を受けたワーカーは、そこで終わる
 * @param server 接続先
 * @param tag 本文を一意にするための印
 * @param count ワーカー数
 * @returns 状態
 */
function startWriters(server: TestServer, tag: string, count: number): Writers {
  const acked = new Map<string, string>();
  const others: number[] = [];
  let stopped = false;
  const worker = async (w: number): Promise<void> => {
    for (let seq = 0; !stopped; seq++) {
      const body = `${tag}-w${w}-n${seq}-${pad(2_000)}`;
      try {
        const res = await postComment(
          server,
          { path: EXAMPLE, startLine: 1, endLine: 1, body, type: 'note' }
        );
        if (res.status !== 201) {
          others.push(res.status);
          return;
        }
        acked.set(body, String(jsonOf(res).id));
      } catch {
        // 落とされた・閉じられたことによる接続エラーは、このテストでは想定内。ワーカーを終える
        return;
      }
    }
  };
  const done = Promise.all(Array.from({ length: count }, (_, w) => worker(w))).then(() => undefined);
  return { acked, others, stop: () => { stopped = true; }, done };
}

/**
 * 成功を返した書き込みが、すべて取得できることを確かめる
 * @param server 接続先
 * @param acked 成功を返した書き込み(本文 → ID)
 * @returns なし
 */
async function expectAllAckedPresent(server: TestServer, acked: Map<string, string>): Promise<void> {
  const all = await listAll(server);
  const byBody = new Map(all.map((c) => [String(c.body), String(c.id)]));
  const missing = [...acked.keys()].filter((b) => !byBody.has(b));
  expect(missing.length, `成功を返したのに取得できない書き込みが ${missing.length} 件ある(例: ${missing[0]?.slice(0, 30)})`).toBe(0);
  for (const [body, id] of acked) {
    expect(byBody.get(body), '応答の ID と、取得した ID が違う').toBe(id);
  }
  expect(new Set(all.map((c) => c.id)).size, 'ID が重複している').toBe(all.length);
  // 中途半端なデータが無い: 取得できる各コメントが、SPEC §2.2 の項目をそろえた完全な形
  for (const c of all) {
    const complete =
      typeof c.id === 'string' && typeof c.path === 'string' && typeof c.body === 'string' &&
      typeof c.status === 'string' && typeof c.type === 'string' && typeof c.author === 'string' &&
      Array.isArray(c.replies) && c.anchor !== null && typeof c.anchor === 'object' &&
      typeof c.createdAt === 'string' && typeof c.updatedAt === 'string';
    expect(complete, `不完全なコメントがある: ${JSON.stringify(c).slice(0, 200)}`).toBe(true);
  }
}

/**
 * 保存先に comments.json 以外のファイル(一時ファイル)が残っていないことを確かめる
 * (SPEC §2.1: 保存先には comments.json だけが置かれる前提。他に作るファイルは SPEC に無い)
 * @param server 対象サーバー
 * @param context 失敗時に添える状況
 * @returns なし
 */
async function expectNoLeftoverFiles(server: TestServer, context: string): Promise<void> {
  const names = (await readdir(server.dataDir)).filter((n) => n !== 'comments.json');
  expect(names, `${context}: 保存先に comments.json 以外が残っている`).toEqual([]);
}

// ─── S2-2: 並行リクエスト ────────────────────────────────────────────────────

describe('S2-2: concurrent requests do not corrupt or lose comments', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ token: DUMMY_TOKEN });
  });
  afterAll(async () => {
    await stopIfStarted(server);
  });

  it(`S2-2: ${CONCURRENT_CREATES} 件の同時作成で、成功を返したものがすべて取得でき、ID が重複せず、再起動後も残る`, async () => {
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_CREATES }, (_, i) =>
        postComment(server, { path: EXAMPLE, startLine: 1, endLine: 1, body: `par-create-${i}`, type: 'note' })
      )
    );
    const ok = results.filter((r) => r.status >= 200 && r.status < 300);
    // 正しい入力を同時に送ったので、すべて成功する(SPEC: 失われない)
    expect(ok.length, `成功が ${ok.length}/${CONCURRENT_CREATES} 件。失敗の例: ${results.find((r) => r.status >= 300)?.text.slice(0, 200)}`).toBe(CONCURRENT_CREATES);

    const ids = ok.map((r) => String(jsonOf(r).id));
    expect(new Set(ids).size, '応答の ID が重複している').toBe(ids.length);

    const check = async (): Promise<void> => {
      const all = await listAll(server);
      const bodies = new Set(all.map((c) => c.body));
      for (let i = 0; i < CONCURRENT_CREATES; i++) expect(bodies.has(`par-create-${i}`), `par-create-${i} が取得できない`).toBe(true);
      expect(new Set(all.map((c) => c.id)).size, 'ID が重複している').toBe(all.length);
      for (const id of ids) expect(all.some((c) => c.id === id), `応答の ID ${id} が取得できない`).toBe(true);
      await expectCommentsFileIsValidJson(server);
    };
    await check();
    await server.restart();
    await check();
  });

  it(`S2-2: 同じコメントへの ${CONCURRENT_REPLIES} 件の同時返信が、すべて残り、返信 ID が重複しない`, async () => {
    const target = await create(server, 'par-reply-target');
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REPLIES }, (_, i) => postReply(server, String(target.id), { body: `par-reply-${i}` }))
    );
    const ok = results.filter((r) => r.status >= 200 && r.status < 300);
    expect(ok.length, `成功が ${ok.length}/${CONCURRENT_REPLIES} 件。失敗の例: ${results.find((r) => r.status >= 300)?.text.slice(0, 200)}`).toBe(CONCURRENT_REPLIES);

    const check = async (): Promise<void> => {
      const c = (await listAll(server)).find((x) => x.id === target.id);
      expect(c, '対象のコメントが取得できない').toBeDefined();
      const replies = (c as JsonObject).replies as JsonObject[];
      expect(new Set(replies.map((r) => r.body)), '返信が失われた、または重複した').toEqual(
        new Set(Array.from({ length: CONCURRENT_REPLIES }, (_, i) => `par-reply-${i}`))
      );
      expect(replies.length).toBe(CONCURRENT_REPLIES);
      expect(new Set(replies.map((r) => r.id)).size, '返信 ID が重複している').toBe(replies.length);
      await expectCommentsFileIsValidJson(server);
    };
    await check();
    await server.restart();
    await check();
  });

  it('S2-2: 状態変更と返信の同時実行で、返信が失われず、状態は送った値のどれかになる', async () => {
    const target = await create(server, 'par-mixed-target');
    const statuses = ['resolved', 'wontfix', 'open'] as const;
    const patches = Array.from({ length: 12 }, (_, i) => patchComment(server, String(target.id), { status: statuses[i % 3] }));
    const replies = Array.from({ length: 12 }, (_, i) => postReply(server, String(target.id), { body: `par-mixed-${i}` }));
    const results = await Promise.all([...patches, ...replies]);
    const bad = results.filter((r) => r.status < 200 || r.status >= 300);
    expect(bad.length, `失敗の例: ${bad[0]?.status} ${bad[0]?.text.slice(0, 200)}`).toBe(0);

    const check = async (): Promise<void> => {
      const c = (await listAll(server)).find((x) => x.id === target.id) as JsonObject;
      expect(c).toBeDefined();
      const rs = c.replies as JsonObject[];
      expect(new Set(rs.map((r) => r.body)).size, '返信が失われた').toBe(12);
      expect(new Set(rs.map((r) => r.id)).size, '返信 ID が重複している').toBe(12);
      expect(statuses as readonly string[]).toContain(c.status);
      await expectCommentsFileIsValidJson(server);
    };
    await check();
    await server.restart();
    await check();
  });
});

// ─── S2-3: 書き込み中の異常終了 ──────────────────────────────────────────────

describe.skipIf(process.platform !== 'linux')('S2-3: SIGKILL during writes keeps comments.json intact', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ token: DUMMY_TOKEN });
    await seed(server);
  }, 60_000);
  afterAll(async () => {
    await stopIfStarted(server);
  });

  it(
    `S2-3: 書き込みを続けながら SIGKILL → 再起動を最大 ${CRASH_ROUNDS} 回繰り返しても、毎回 comments.json が正しい JSON で、成功を返した分が取得できる`,
    async () => {
      const acked = new Map<string, string>();
      const startedAt = Date.now();
      for (let round = 0; round < CRASH_ROUNDS; round++) {
        const writers = startWriters(server, `crash${round}`, WRITERS);
        // 成功の応答が実際に返り始めるまで待ち、ラウンドごとに少しずつ違う間隔で落とす(固定の sleep だけに頼らない)
        const writing = await waitUntil(async () => writers.acked.size >= 3, 10_000, 10);
        expect(writing, '書き込みが成功しないので、落とすタイミングを作れない').toBe(true);
        const extra = 5 + ((round * 37) % 60);
        await new Promise<void>((r) => setTimeout(r, extra));

        await server.crash();
        writers.stop();
        await writers.done;
        for (const [b, id] of writers.acked) acked.set(b, id);

        // 落ちた直後の状態(再起動前)
        await expectCommentsFileIsValidJson(server);

        await server.start();
        try {
          await expectCommentsFileIsValidJson(server);
          await expectAllAckedPresent(server, acked);
        } catch (err) {
          throw new Error(`S2-3 ラウンド ${round} で失敗: ${String(err)}`, { cause: err });
        }

        // 再起動後も書き込める
        await create(server, `after-crash-${round}`);

        if (Date.now() - startedAt > 40_000) break; // 時間の上限(遅い環境でもテストが長引かないように)
      }
      expect(acked.size, '成功を返した書き込みが 1 件も無い').toBeGreaterThan(0);
    },
    90_000
  );
});

describe.skipIf(process.platform !== 'linux')('S2-3: temporary files after SIGKILL', () => {
  it(
    'S2-3: SIGKILL → 再起動(待ち受け開始)の時点で、保存先に comments.json 以外のファイルが残っていない(3 回)',
    async () => {
      const server = await startTestServer({ token: DUMMY_TOKEN });
      try {
        await seed(server);
        for (let round = 0; round < 3; round++) {
          const writers = startWriters(server, `tmp${round}`, WRITERS);
          expect(await waitUntil(async () => writers.acked.size >= 3, 10_000, 10)).toBe(true);
          await new Promise<void>((r) => setTimeout(r, 5 + round * 20));
          await server.crash();
          writers.stop();
          await writers.done;
          // 落ちた直後に一時ファイルが残っているかは確率的なので、断定しない。再起動後だけを見る(SPEC §2.1)
          await server.start();
          await expectNoLeftoverFiles(server, `S2-3 ラウンド ${round}`);
        }
      } finally {
        await server.stop();
      }
    },
    60_000
  );
});

// ─── C-6: 書き込みの途中で SIGTERM / SIGINT ──────────────────────────────────

describe.skipIf(process.platform !== 'linux')('C-6: SIGTERM / SIGINT during writes', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)(
    'C-6: 書き込みを続けている最中の %s で、5 秒以内に終了コード 0、comments.json が正しい JSON、成功を返した分が残り、ログに秘密が出ない',
    async (signal) => {
      const server = await startTestServer({
        token: DUMMY_TOKEN,
        setup: async (repoDir) => {
          await writeFile(join(repoDir, '.env'), `API_KEY=${SECRET_SENTINEL}\n`);
        },
      });
      try {
        await seed(server);
        const writers = startWriters(server, `term-${signal}`, WRITERS);
        const writing = await waitUntil(async () => writers.acked.size >= 3, 10_000, 10);
        expect(writing, '書き込みが成功しないので、シグナルを送るタイミングを作れない').toBe(true);

        // 書き込みを続けている最中に、サーバー本体だけへシグナルを送り、終了コードを観測する
        const result = await server.signalAndWait(signal, true);
        writers.stop();
        await writers.done;

        expect(result.forced, `${signal} では終了せず、SIGKILL が必要だった`).toBe(false);
        expect(result.elapsedMs, `${signal} から終了までに ${result.elapsedMs}ms かかった`).toBeLessThanOrEqual(5_000);
        expect(result.exitCode, `終了コードが 0 ではない。出力:\n${server.logs().slice(-1500)}`).toBe(0);

        // 終了処理中に届いた書き込みは 503 で断る(接続を受け付けない場合は、接続エラーでワーカーが終わる)
        expect(writers.others.filter((st) => st !== 503), '終了処理中の書き込みに 503 以外の応答があった').toEqual([]);

        // 止まった直後の状態
        await expectCommentsFileIsValidJson(server);
        await expectNoLeftoverFiles(server, `${signal} による終了のあと`);

        // 起動し直して、成功を返した分がすべて残っていること
        await server.start();
        await expectCommentsFileIsValidJson(server);
        expect(writers.acked.size).toBeGreaterThan(0);
        await expectAllAckedPresent(server, writers.acked);

        const logs = server.logs();
        expect(logs, 'ログにトークンが出ている').not.toContain(DUMMY_TOKEN);
        expect(logs, 'ログに秘密ファイルの中身が出ている').not.toContain(SECRET_SENTINEL);
      } finally {
        await server.stop();
      }
    },
    60_000
  );
});

// ─── 一時ファイルの掃除(ダミーを使う検証は SPEC に名前が無いので保留) ──────────

describe('S2-3: stale temporary files', () => {
  it.todo('S2-3: 保存先に置いた一時ファイルらしきダミーが、起動時に掃除される(一時ファイルの名前が SPEC に無いため、人間の判断待ち)');
});
