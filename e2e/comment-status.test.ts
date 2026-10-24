/**
 * e2e コメント API テスト(ステージ2 / B2: ステータス遷移・返信・リポジトリ不変)
 * 対象基準: S2-7(遷移・不正値)、S2-8(PATCH・返信でも対象リポジトリは不変)、
 *           C-2・C-5(PATCH と返信 POST への回帰)
 *
 * SPEC §2.1、§2.2「コメント API の形」(PATCH、replies、エラー)、§5 だけを根拠とする。src/ は読まない。
 * SPEC が決めていない点(resolved → wontfix のときの resolution の扱い、open と同時に resolution を送ったとき、
 * resolution が null のとき、PATCH での updatedAt の変化など)は断定しない。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commentsOf, getComments, jsonOf, patchComment, postComment, postReply, type JsonObject } from './helpers/comments.js';
import { request } from './helpers/http.js';
import { startTestServer, stopIfStarted, type TestServer } from './helpers/server.js';
import { snapshotTree } from './helpers/snapshot.js';

const DUMMY_TOKEN = 'E2E_DUMMY_TOKEN_NOT_A_REAL_SECRET_S2_B2';
const SECRET_SENTINEL = 'E2E_B2_SECRET_SENTINEL_MUST_NOT_LEAK';
const EXAMPLE = 'src/example.ts';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const STATUSES = ['open', 'resolved', 'wontfix'] as const;

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    token: DUMMY_TOKEN,
    setup: async (repoDir) => {
      await mkdir(join(repoDir, 'notes'), { recursive: true });
      await writeFile(join(repoDir, '.env'), `API_KEY=${SECRET_SENTINEL}\n`);
    },
  });
});

afterAll(async () => {
  await stopIfStarted(server);
});

/**
 * 新しいコメントを1件作る
 * @param over 作成リクエストの上書き
 * @returns 作成された Comment(JSON)
 */
async function create(over: Record<string, unknown> = {}): Promise<JsonObject> {
  const res = await postComment(server, { path: EXAMPLE, startLine: 1, endLine: 1, body: 'B2 対象', type: 'instruction', ...over });
  expect(res.status, res.text).toBe(201);
  return jsonOf(res);
}

/**
 * 1件のコメントを一覧から取り出す
 * @param id コメントの ID
 * @returns Comment(JSON)。無ければ undefined
 */
async function fetchOne(id: string): Promise<JsonObject | undefined> {
  const res = await getComments(server);
  expect(res.status).toBe(200);
  return commentsOf(res).find((c) => c.id === id);
}

/**
 * 全コメントを JSON 文字列にして返す(状態不変の比較用)
 * @returns JSON 文字列
 */
async function dumpAll(): Promise<string> {
  const res = await getComments(server);
  expect(res.status).toBe(200);
  return JSON.stringify(commentsOf(res));
}

/**
 * 指定ミリ秒だけ待つ(updatedAt の時刻差を作るためだけに使う。状態の待ち合わせには使わない)
 * @param ms ミリ秒
 * @returns なし
 */
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── S2-7: ステータス遷移 ───────────────────────────────────────────────────

describe('S2-7: ステータスの遷移', () => {
  it('S2-7: open → resolved(resolution つき)→ open(resolution は null)→ wontfix → open', async () => {
    const c = await create();
    const id = c.id as string;

    let res = await patchComment(server, id, { status: 'resolved', resolution: '直しました' });
    expect(res.status, res.text).toBe(200);
    let j = jsonOf(res);
    expect(j.id).toBe(id);
    expect(j.status).toBe('resolved');
    expect(j.resolution).toBe('直しました');

    res = await patchComment(server, id, { status: 'open' });
    expect(res.status, res.text).toBe(200);
    j = jsonOf(res);
    expect(j.status).toBe('open');
    expect(j.resolution).toBeNull();

    res = await patchComment(server, id, { status: 'wontfix', resolution: '対応しない' });
    expect(res.status, res.text).toBe(200);
    j = jsonOf(res);
    expect(j.status).toBe('wontfix');
    expect(j.resolution).toBe('対応しない');

    res = await patchComment(server, id, { status: 'open' });
    expect(res.status, res.text).toBe(200);
    expect(jsonOf(res).status).toBe('open');
    expect(jsonOf(res).resolution).toBeNull();
  });

  // 3 x 3 のすべての組み合わせ(同じ値を含む)
  const pairs = STATUSES.flatMap((from) => STATUSES.map((to): [string, string] => [from, to]));
  it.each(pairs)('S2-7: %s から %s へ変更できる(同じ値も成功)', async (from, to) => {
    const c = await create();
    const id = c.id as string;
    if (from !== 'open') {
      const pre = await patchComment(server, id, { status: from, resolution: `from ${from}` });
      expect(pre.status, pre.text).toBe(200);
    }
    const res = await patchComment(server, id, to === 'open' ? { status: to } : { status: to, resolution: `to ${to}` });
    expect(res.status, res.text).toBe(200);
    const j = jsonOf(res);
    expect(j.status).toBe(to);
    if (to === 'open') expect(j.resolution).toBeNull();
    else expect(j.resolution).toBe(`to ${to}`);
    // 一覧にも反映され、status の絞り込みにも使える
    expect((await fetchOne(id))?.status).toBe(to);
    const filtered = commentsOf(await getComments(server, `status=${to}`)).map((x) => x.id);
    expect(filtered).toContain(id);
  });

  it('S2-7: resolution を付けずに resolved / wontfix にできる', async () => {
    for (const status of ['resolved', 'wontfix']) {
      const c = await create();
      const res = await patchComment(server, c.id as string, { status });
      expect(res.status, res.text).toBe(200);
      expect(jsonOf(res).status).toBe(status);
    }
  });

  it('S2-7: PATCH は status 以外(body、author、type、path、anchor、replies)を変えない', async () => {
    const c = await create({ body: 'そのまま残る本文', type: 'note' });
    await postReply(server, c.id as string, { body: '返信' });
    const before = await fetchOne(c.id as string);
    const res = await patchComment(server, c.id as string, { status: 'resolved', resolution: 'ok' });
    expect(res.status, res.text).toBe(200);
    const j = jsonOf(res);
    for (const k of ['id', 'path', 'anchor', 'body', 'author', 'type', 'replies', 'createdAt']) {
      expect(j[k], k).toEqual(before?.[k]);
    }
    expect(j.author).toBe('human');
  });

  it('S2-7: 再起動後も、変更したステータスと resolution が残る', async () => {
    const a = await create();
    const b = await create();
    expect((await patchComment(server, a.id as string, { status: 'resolved', resolution: '再起動前に解決' })).status).toBe(200);
    expect((await patchComment(server, b.id as string, { status: 'wontfix', resolution: '再起動前に見送り' })).status).toBe(200);
    const before = await dumpAll();
    await server.restart();
    expect(await dumpAll()).toBe(before);
    const ra = await fetchOne(a.id as string);
    const rb = await fetchOne(b.id as string);
    expect([ra?.status, ra?.resolution]).toEqual(['resolved', '再起動前に解決']);
    expect([rb?.status, rb?.resolution]).toEqual(['wontfix', '再起動前に見送り']);
  });

  describe('不正な入力は 400 で、状態は変わらない', () => {
    const bad: Array<[label: string, payload: unknown]> = [
      ['status が 3 つ以外の値(done)', { status: 'done' }],
      ['status が大文字(OPEN)', { status: 'OPEN' }],
      ['status が大文字始まり(Resolved)', { status: 'Resolved' }],
      ['status が空文字', { status: '' }],
      ['status が空白つき', { status: ' open' }],
      ['status が数値', { status: 1 }],
      ['status が真偽値', { status: true }],
      ['status が配列', { status: ['open'] }],
      ['status がオブジェクト', { status: { value: 'open' } }],
      ['status が null', { status: null }],
      ['status の欠落(空のオブジェクト)', {}],
      ['status の欠落(resolution だけ)', { resolution: 'x' }],
      ['body を含む(status あり)', { status: 'resolved', body: '書き換え' }],
      ['body だけ', { body: '書き換え' }],
      ['author を含む', { status: 'resolved', author: 'ai' }],
      ['type を含む', { status: 'resolved', type: 'note' }],
      ['path を含む', { status: 'resolved', path: 'src/other.ts' }],
      ['anchor を含む', { status: 'resolved', anchor: { startLine: 1, endLine: 1, quote: 'x', docHash: 'x' } }],
      ['replies を含む', { status: 'resolved', replies: [] }],
      ['id を含む', { status: 'resolved', id: 'other' }],
      ['未知のフィールド', { status: 'resolved', extra: 1 }],
      ['resolution が文字列でない(数値)', { status: 'resolved', resolution: 123 }],
      ['resolution が文字列でない(オブジェクト)', { status: 'wontfix', resolution: { a: 1 } }],
      ['JSON でない', '{not json'],
      ['JSON が配列', '[]'],
      ['JSON が null', 'null'],
      ['JSON が文字列', '"resolved"'],
      ['本文が空', ''],
    ];
    it.each(bad)('S2-7: %s', async (_label, payload) => {
      const c = await create({ body: 'B2 不正値の対象' });
      // 変更後の状態(resolved)から試して、変わらないことを確かめる
      const pre = await patchComment(server, c.id as string, { status: 'resolved', resolution: '前の状態' });
      expect(pre.status, pre.text).toBe(200);
      const before = await dumpAll();
      const res = await patchComment(server, c.id as string, payload);
      expect(res.status, res.text).toBe(400);
      expect(await dumpAll(), '400 を返したのに状態が変わった').toBe(before);
      const after = await fetchOne(c.id as string);
      expect(after?.status).toBe('resolved');
      expect(after?.resolution).toBe('前の状態');
      expect(after?.body).toBe('B2 不正値の対象');
    });
  });

  it('S2-7: 存在しない id への PATCH は 404 で、何も作られない', async () => {
    const before = await dumpAll();
    for (const id of ['no-such-id', '00000000-0000-0000-0000-000000000000', '%2e%2e', 'a%2Fb']) {
      const res = await patchComment(server, id, { status: 'resolved' });
      expect([404], `${id}: ${res.text}`).toContain(res.status);
    }
    expect(await dumpAll()).toBe(before);
  });
});

// ─── S2-7: 返信 ─────────────────────────────────────────────────────────────

describe('S2-7: 返信', () => {
  it('S2-7: 返信は 201 と更新後の Comment を返し、author=human、createdAt は ISO 8601', async () => {
    const c = await create({ body: '返信の対象' });
    const res = await postReply(server, c.id as string, { body: '最初の返信' });
    expect(res.status, res.text).toBe(201);
    const j = jsonOf(res);
    expect(j.id).toBe(c.id);
    expect(j.body).toBe('返信の対象');
    expect(j.status).toBe('open');
    expect(Array.isArray(j.replies)).toBe(true);
    expect(j.replies).toHaveLength(1);
    const r = j.replies[0];
    expect(typeof r.id === 'string' && r.id.length > 0).toBe(true);
    expect(r.author).toBe('human');
    expect(r.body).toBe('最初の返信');
    expect(String(r.createdAt)).toMatch(ISO);
  });

  it('S2-7: 複数の返信は、追加した順に並び、id は重複せず、一覧からも取得できる', async () => {
    const c = await create();
    const bodies = ['one', 'two', 'three', 'four'];
    let last: JsonObject = c;
    for (const body of bodies) {
      const res = await postReply(server, c.id as string, { body });
      expect(res.status, res.text).toBe(201);
      last = jsonOf(res);
    }
    expect(last.replies.map((r: JsonObject) => r.body)).toEqual(bodies);
    const ids = last.replies.map((r: JsonObject) => r.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    const times = last.replies.map((r: JsonObject) => Date.parse(r.createdAt as string));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const listed = await fetchOne(c.id as string);
    expect(listed?.replies.map((r: JsonObject) => r.body)).toEqual(bodies);
    expect(listed?.replies.map((r: JsonObject) => r.id)).toEqual(ids);
    expect(listed?.replies.every((r: JsonObject) => r.author === 'human')).toBe(true);
  });

  it('S2-7: 返信を追加すると、コメントの updatedAt が更新される(createdAt は変わらない)', async () => {
    const c = await create();
    await pause(30);
    const res = await postReply(server, c.id as string, { body: '更新時刻を進める' });
    expect(res.status, res.text).toBe(201);
    const j = jsonOf(res);
    expect(String(j.updatedAt)).toMatch(ISO);
    expect(Date.parse(j.updatedAt)).toBeGreaterThan(Date.parse(c.updatedAt));
    expect(j.createdAt).toBe(c.createdAt);
    expect((await fetchOne(c.id as string))?.updatedAt).toBe(j.updatedAt);
    // 2 件目でも進む
    await pause(30);
    const res2 = await postReply(server, c.id as string, { body: '2 件目' });
    expect(Date.parse(jsonOf(res2).updatedAt)).toBeGreaterThan(Date.parse(j.updatedAt));
  });

  it('S2-7: 返信は、他のコメントの返信・状態に影響しない', async () => {
    const a = await create();
    const b = await create();
    await postReply(server, a.id as string, { body: 'a への返信' });
    const fb = await fetchOne(b.id as string);
    expect(fb?.replies).toEqual([]);
    expect(fb?.updatedAt).toBe(b.updatedAt);
  });

  it('S2-7: 解決済みのコメントにも返信でき、返信してもステータスは変わらない', async () => {
    const c = await create();
    await patchComment(server, c.id as string, { status: 'resolved', resolution: 'done' });
    const res = await postReply(server, c.id as string, { body: '解決後の返信' });
    expect(res.status, res.text).toBe(201);
    expect(jsonOf(res).status).toBe('resolved');
    expect(jsonOf(res).resolution).toBe('done');
  });

  it('S2-7: 本文がちょうど 32 KiB(32,768 バイト、マルチバイトを含む)の返信は成功する', async () => {
    const c = await create();
    const body = 'あ'.repeat(10_922) + 'aa';
    expect(Buffer.byteLength(body, 'utf8')).toBe(32_768);
    const res = await postReply(server, c.id as string, { body });
    expect(res.status, res.text.slice(0, 200)).toBe(201);
    expect(jsonOf(res).replies[0].body).toBe(body);
  });

  it('S2-7: 再起動後も、返信(順序・author・createdAt・id)とコメントの updatedAt が残る', async () => {
    const c = await create();
    for (const body of ['before restart 1', 'before restart 2']) {
      expect((await postReply(server, c.id as string, { body })).status).toBe(201);
    }
    const before = await fetchOne(c.id as string);
    await server.restart();
    const after = await fetchOne(c.id as string);
    expect(after).toEqual(before);
    expect(after?.replies.map((r: JsonObject) => r.body)).toEqual(['before restart 1', 'before restart 2']);
    // 再起動後も追加できる
    const res = await postReply(server, c.id as string, { body: 'after restart' });
    expect(res.status, res.text).toBe(201);
    expect(jsonOf(res).replies.map((r: JsonObject) => r.body)).toEqual(['before restart 1', 'before restart 2', 'after restart']);
  });

  describe('不正な返信は 400 で、状態は変わらない', () => {
    const bad: Array<[label: string, payload: unknown]> = [
      ['author を含む(human)', { body: 'x', author: 'human' }],
      ['author を含む(ai)', { body: 'x', author: 'ai' }],
      ['未知のフィールド', { body: 'x', extra: 1 }],
      ['id を含む', { body: 'x', id: 'mine' }],
      ['createdAt を含む', { body: 'x', createdAt: '2000-01-01T00:00:00Z' }],
      ['body の欠落', {}],
      ['body が文字列でない(数値)', { body: 1 }],
      ['body が文字列でない(null)', { body: null }],
      ['body が文字列でない(オブジェクト)', { body: { text: 'x' } }],
      ['本文が空', { body: '' }],
      ['本文が空白文字だけ(スペース)', { body: '   ' }],
      ['本文が空白文字だけ(改行とタブ)', { body: ' \n\t \r\n ' }],
      ['本文が 32 KiB 超(ASCII)', { body: 'a'.repeat(32_769) }],
      ['本文が 32 KiB 超(UTF-8 で 32,769 バイト)', { body: 'あ'.repeat(10_923) }],
      ['JSON でない', '{not json'],
      ['JSON が配列', '[]'],
      ['JSON が null', 'null'],
      ['本文が空(リクエスト)', ''],
    ];
    it.each(bad)('S2-7: %s', async (_label, payload) => {
      const c = await create();
      expect((await postReply(server, c.id as string, { body: '既存の返信' })).status).toBe(201);
      const before = await dumpAll();
      const res = await postReply(server, c.id as string, payload);
      expect(res.status, res.text.slice(0, 200)).toBe(400);
      expect(await dumpAll(), '400 を返したのに状態が変わった').toBe(before);
    });
  });

  it('S2-7: 存在しない id への返信は 404 で、何も作られない', async () => {
    const before = await dumpAll();
    for (const id of ['no-such-id', '00000000-0000-0000-0000-000000000000', '%2e%2e', 'a%2Fb']) {
      const res = await postReply(server, id, { body: 'x' });
      expect([404], `${id}: ${res.text}`).toContain(res.status);
    }
    expect(await dumpAll()).toBe(before);
  });
});

// ─── C-2: PATCH と返信 POST への回帰 ────────────────────────────────────────

describe('C-2: PATCH と返信 POST の Origin 検証', () => {
  const badOrigins = ['http://evil.example', 'null', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example'];

  it('C-2: PATCH は Origin が許可リスト外なら 403 で、状態は変わらない', async () => {
    const c = await create();
    const before = await dumpAll();
    for (const origin of [...badOrigins, `http://127.0.0.1:${server.port + 1}`]) {
      const res = await patchComment(server, c.id as string, { status: 'resolved', resolution: 'evil' }, { Origin: origin });
      expect(res.status, `Origin: ${origin}`).toBe(403);
    }
    expect(await dumpAll()).toBe(before);
    expect((await fetchOne(c.id as string))?.status).toBe('open');
  });

  it('C-2: 返信 POST は Origin が許可リスト外なら 403 で、返信は付かない', async () => {
    const c = await create();
    const before = await dumpAll();
    for (const origin of [...badOrigins, `http://127.0.0.1:${server.port + 1}`]) {
      const res = await postReply(server, c.id as string, { body: 'evil' }, { Origin: origin });
      expect(res.status, `Origin: ${origin}`).toBe(403);
    }
    expect(await dumpAll()).toBe(before);
    expect((await fetchOne(c.id as string))?.replies).toEqual([]);
  });

  it('C-2: Origin が無く Content-Type が JSON でないなら、PATCH も返信 POST も 403 で変更されない', async () => {
    const c = await create();
    const before = await dumpAll();
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const p = await patchComment(server, c.id as string, { status: 'resolved' }, { 'Content-Type': ct });
      expect(p.status, `PATCH ${ct}`).toBe(403);
      const r = await postReply(server, c.id as string, { body: 'evil' }, { 'Content-Type': ct });
      expect(r.status, `reply ${ct}`).toBe(403);
    }
    expect(await dumpAll()).toBe(before);
  });

  it('C-2: 許可された Origin + JSON なら、PATCH も返信 POST も成功する', async () => {
    const c = await create();
    const origin = { Origin: `http://127.0.0.1:${server.port}` };
    const p = await patchComment(server, c.id as string, { status: 'resolved', resolution: 'ok' }, origin);
    expect(p.status, p.text).toBe(200);
    const r = await postReply(server, c.id as string, { body: 'ok' }, origin);
    expect(r.status, r.text).toBe(201);
    const origin2 = { Origin: `http://localhost:${server.port}` };
    expect((await patchComment(server, c.id as string, { status: 'open' }, origin2)).status).toBe(200);
  });

  it('C-2: 許可リスト外の Host は、PATCH も返信 POST も 403 で変更されない(C-1 の回帰)', async () => {
    const c = await create();
    const before = await dumpAll();
    const p = await patchComment(server, c.id as string, { status: 'resolved' }, { Host: 'evil.example' });
    expect(p.status).toBe(403);
    const r = await postReply(server, c.id as string, { body: 'evil' }, { Host: 'evil.example' });
    expect(r.status).toBe(403);
    expect(await dumpAll()).toBe(before);
  });
});

// ─── C-5: 秘密を出さない ────────────────────────────────────────────────────

describe('C-5: PATCH と返信の応答・ログに秘密を出さない', () => {
  it('C-5: エラー応答とログに、秘密ファイルの中身・トークン・保存先や対象リポジトリの実体パスが出ない', async () => {
    const c = await create();
    const texts: string[] = [];
    const push = (res: { text: string; headers: unknown }): void => {
      texts.push(res.text, JSON.stringify(res.headers));
    };
    push(await patchComment(server, 'no-such-id', { status: 'resolved' }));
    push(await patchComment(server, c.id as string, { status: 'done' }));
    push(await patchComment(server, c.id as string, { status: 'open', body: 'x' }));
    push(await patchComment(server, c.id as string, '{not json'));
    push(await postReply(server, 'no-such-id', { body: 'x' }));
    push(await postReply(server, c.id as string, { body: '' }));
    push(await postReply(server, c.id as string, { body: 'x', author: 'ai' }));
    push(await postReply(server, c.id as string, { body: 'a'.repeat(40_000) }));
    push(await patchComment(server, c.id as string, { status: 'open' }, { Origin: 'http://evil.example' }));
    push(await request(server, '/api/comments?status=bogus'));
    const joined = texts.join('\n');
    for (const [label, text] of [['応答', joined], ['ログ', server.logs()]] as const) {
      expect(text, label).not.toContain(SECRET_SENTINEL);
      expect(text, label).not.toContain(DUMMY_TOKEN);
    }
    expect(joined, '応答に実体のパス').not.toContain(server.baseDir);
    expect(joined, '応答に保存先のパス').not.toContain(server.dataDir);
  });
});

// ─── S2-8: 対象リポジトリは変わらない ───────────────────────────────────────

describe('S2-8: PATCH・返信でも、対象リポジトリの内容は操作の前後で変わらない', () => {
  it('S2-8: 作成・状態変更・返信・拒否される操作・再起動を行っても、repoDir は変わらない', async () => {
    const before = await snapshotTree(server.repoDir);
    const c = await create();
    const id = c.id as string;
    expect((await patchComment(server, id, { status: 'resolved', resolution: 'S2-8' })).status).toBe(200);
    expect((await patchComment(server, id, { status: 'open' })).status).toBe(200);
    expect((await patchComment(server, id, { status: 'wontfix' })).status).toBe(200);
    expect((await postReply(server, id, { body: 'S2-8 返信 1' })).status).toBe(201);
    expect((await postReply(server, id, { body: 'S2-8 返信 2' })).status).toBe(201);
    // 拒否される操作
    await patchComment(server, id, { status: 'done' });
    await patchComment(server, id, { status: 'open', body: 'x' });
    await patchComment(server, 'no-such-id', { status: 'open' });
    await postReply(server, id, { body: '' });
    await postReply(server, id, { body: 'x', author: 'ai' });
    await postReply(server, 'no-such-id', { body: 'x' });
    await patchComment(server, id, { status: 'open' }, { Origin: 'http://evil.example' });
    await postReply(server, id, { body: 'x' }, { Origin: 'http://evil.example' });
    expect(await snapshotTree(server.repoDir), '操作の途中で対象リポジトリが変わった').toEqual(before);
    await server.restart();
    expect((await fetchOne(id))?.replies).toHaveLength(2);
    expect((await postReply(server, id, { body: 'S2-8 再起動後' })).status).toBe(201);
    expect(await snapshotTree(server.repoDir), '再起動後に対象リポジトリが変わった').toEqual(before);
  });
});
