/**
 * e2e コメント API テスト(ステージ2 / B1: 作成・取得・永続・path 検証)
 * 対象基準: S2-1(作成・取得・永続)、S2-4(path の検証)、C-2・C-5(POST への回帰)
 *
 * SPEC §2.1、§2.2「コメント API の形」、§5 だけを根拠とする。src/ は読まない。
 * 保存ファイルの中身の形には依存しない(comments.json が保存先にできることだけを確かめる)。
 * `position` は B1 の範囲外(後続のブランチ)なので、ここでは確かめない。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commentsOf, getComments, jsonOf, postComment } from './helpers/comments.js';
import { createDeniedFiles, listDeniedFiles } from './helpers/fixtures.js';
import { request, waitUntil } from './helpers/http.js';
import { FIXTURES_REPO, startTestServer, stopIfStarted, type TestServer } from './helpers/server.js';

const OUTSIDE_SENTINEL = 'E2E_OUTSIDE_REPO_SENTINEL_MUST_NOT_LEAK';
const DUMMY_TOKEN = 'E2E_DUMMY_TOKEN_NOT_A_REAL_SECRET_S2';
const EXAMPLE = 'src/example.ts';
const CRLF_FILE = 'notes/crlf.txt';
const NO_EOL_FILE = 'notes/no-trailing-newline.txt';

/**
 * ファイルの内容を、SPEC の規則で行に分ける(`\n` で分け、末尾の改行の後ろは行にせず、`\r` を含めない)
 * @param content ファイルの内容
 * @returns 行の配列
 */
function splitLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

let server: TestServer;
let exampleContent = '';
let exampleLines: string[] = [];
const denied = listDeniedFiles();

beforeAll(async () => {
  exampleContent = await readFile(join(FIXTURES_REPO, EXAMPLE), 'utf8');
  exampleLines = splitLines(exampleContent);
  server = await startTestServer({
    token: DUMMY_TOKEN,
    setup: async (repoDir) => {
      await createDeniedFiles(repoDir);
      await mkdir(join(repoDir, 'notes'), { recursive: true });
      await writeFile(join(repoDir, CRLF_FILE), 'alpha\r\nbeta\r\ngamma\r\n');
      await writeFile(join(repoDir, NO_EOL_FILE), 'first\nsecond');
      // 巨大(1MB 超)とバイナリ
      await writeFile(join(repoDir, 'large-file.txt'), 'x'.repeat(99).concat('\n').repeat(11_000));
      await writeFile(
        join(repoDir, 'image.png'),
        Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00]), Buffer.from('E2E_BIN')])
      );
      // リポジトリの外のファイルと、それを指すシンボリックリンク
      const base = dirname(repoDir);
      await writeFile(join(base, 'outside-secret.txt'), `${OUTSIDE_SENTINEL}\n`);
      await mkdir(join(base, 'outside-dir'), { recursive: true });
      await writeFile(join(base, 'outside-dir', 'inner.txt'), `${OUTSIDE_SENTINEL}\n`);
      await symlink(join(base, 'outside-secret.txt'), join(repoDir, 'link-abs-file.txt'));
      await symlink('../outside-secret.txt', join(repoDir, 'link-rel-file.txt'));
      await symlink(join(base, 'outside-dir'), join(repoDir, 'link-dir'));
      await symlink('link-abs-file.txt', join(repoDir, 'link-chain.txt'));
      await symlink('../../outside-secret.txt', join(repoDir, 'src/link-in-subdir.ts'));
    },
  });
});

afterAll(async () => {
  await stopIfStarted(server);
});

/**
 * 現在の全コメント数を数える
 * @returns コメント数
 */
async function countAll(): Promise<number> {
  const res = await getComments(server);
  expect(res.status).toBe(200);
  return commentsOf(res).length;
}

/**
 * 有効な作成リクエストを作る(上書きできる)
 * @param over 上書きする項目
 * @returns リクエストの JSON
 */
function valid(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { path: EXAMPLE, startLine: 1, endLine: 1, body: 'e2e comment', type: 'note', ...over };
}

// ─── S2-1: 作成・取得・永続 ──────────────────────────────────────────────────

describe('S2-1: コメントを作成して取得できる', () => {
  it('S2-1: POST /api/comments は 201 と Comment を返す(author=human、status=open、replies は空)', async () => {
    const endLine = Math.min(3, exampleLines.length);
    const res = await postComment(server, valid({ startLine: 1, endLine, body: 'S2-1 作成', type: 'instruction' }));
    expect(res.status, res.text).toBe(201);
    const c = jsonOf(res);
    expect(typeof c.id === 'string' && c.id.length > 0, 'id が文字列でない').toBe(true);
    expect(c.path).toBe(EXAMPLE);
    expect(c.body).toBe('S2-1 作成');
    expect(c.author).toBe('human');
    expect(c.type).toBe('instruction');
    expect(c.status).toBe('open');
    expect(c.replies).toEqual([]);
    expect(c.resolution === null || c.resolution === undefined, 'resolution は null').toBe(true);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
    expect(String(c.createdAt)).toMatch(iso);
    expect(String(c.updatedAt)).toMatch(iso);
    expect(c.anchor.startLine).toBe(1);
    expect(c.anchor.endLine).toBe(endLine);
  });

  it('S2-1: anchor.quote は該当行を \\n でつないだものと一致し、docHash は SHA-256 の16進文字列', async () => {
    const endLine = Math.min(4, exampleLines.length);
    const res = await postComment(server, valid({ startLine: 2, endLine }));
    expect(res.status, res.text).toBe(201);
    const a = jsonOf(res).anchor;
    expect(a.quote).toBe(exampleLines.slice(1, endLine).join('\n'));
    const full = createHash('sha256').update(exampleContent).digest('hex');
    expect(String(a.docHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(a.docHash, 'docHash がファイル内容の SHA-256 全体と一致しない').toBe(full);
  });

  it('S2-1: \\r\\n のファイルの quote には \\r が含まれない', async () => {
    const res = await postComment(server, valid({ path: CRLF_FILE, startLine: 1, endLine: 2 }));
    expect(res.status, res.text).toBe(201);
    expect(jsonOf(res).anchor.quote).toBe('alpha\nbeta');
  });

  it('S2-1: 末尾の改行の後ろは行にしない(最終行までは可、その次は 400)', async () => {
    const ok = await postComment(server, valid({ path: CRLF_FILE, startLine: 3, endLine: 3 }));
    expect(ok.status, ok.text).toBe(201);
    expect(jsonOf(ok).anchor.quote).toBe('gamma');
    const over = await postComment(server, valid({ path: CRLF_FILE, startLine: 3, endLine: 4 }));
    expect(over.status).toBe(400);
    // 末尾の改行が無いファイルでも、最終行まで
    const last = await postComment(server, valid({ path: NO_EOL_FILE, startLine: 2, endLine: 2 }));
    expect(last.status, last.text).toBe(201);
    expect(jsonOf(last).anchor.quote).toBe('second');
    const over2 = await postComment(server, valid({ path: NO_EOL_FILE, startLine: 2, endLine: 3 }));
    expect(over2.status).toBe(400);
  });

  it('S2-1: 作成したコメントを GET /api/comments で取得できる(返信は空、author=human)', async () => {
    const created = jsonOf(await postComment(server, valid({ body: 'S2-1 取得用', startLine: 1, endLine: 1 })));
    const res = await getComments(server);
    expect(res.status).toBe(200);
    const found = commentsOf(res).find((c) => c.id === created.id);
    expect(found, '作成したコメントが一覧に無い').toBeDefined();
    expect(found?.body).toBe('S2-1 取得用');
    expect(found?.author).toBe('human');
    expect(found?.status).toBe('open');
    expect(found?.replies).toEqual([]);
    expect(found?.anchor).toEqual(created.anchor);
  });

  it('S2-1: 一覧は作成日時の昇順(同時刻は作成順)で返る', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await postComment(server, valid({ path: NO_EOL_FILE, startLine: 1, endLine: 1, body: `order ${i}` }));
      expect(res.status, res.text).toBe(201);
      ids.push(jsonOf(res).id as string);
    }
    const list = commentsOf(await getComments(server, `path=${NO_EOL_FILE}`)).map((c) => c.id as string);
    const mine = list.filter((id) => ids.includes(id));
    expect(mine).toEqual(ids);
    const all = commentsOf(await getComments(server));
    const times = all.map((c) => Date.parse(c.createdAt as string));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('S2-1: path・status・type の絞り込みは、指定したものだけで絞る', async () => {
    const a = jsonOf(await postComment(server, valid({ path: 'subdir/normal.ts', startLine: 1, endLine: 1, type: 'instruction', body: 'filter A' })));
    const b = jsonOf(await postComment(server, valid({ path: 'subdir/normal.ts', startLine: 1, endLine: 1, type: 'note', body: 'filter B' })));
    const byPath = commentsOf(await getComments(server, 'path=subdir%2Fnormal.ts')).map((c) => c.id);
    expect(byPath).toContain(a.id);
    expect(byPath).toContain(b.id);
    expect(commentsOf(await getComments(server, 'path=subdir%2Fnormal.ts')).every((c) => c.path === 'subdir/normal.ts')).toBe(true);
    const byType = commentsOf(await getComments(server, 'path=subdir%2Fnormal.ts&type=instruction')).map((c) => c.id);
    expect(byType).toContain(a.id);
    expect(byType).not.toContain(b.id);
    const byStatus = commentsOf(await getComments(server, 'path=subdir%2Fnormal.ts&status=open')).map((c) => c.id);
    expect(byStatus).toEqual(expect.arrayContaining([a.id, b.id]));
    const none = commentsOf(await getComments(server, 'path=subdir%2Fnormal.ts&status=resolved'));
    expect(none).toEqual([]);
    const onlyType = commentsOf(await getComments(server, 'type=note')).map((c) => c.id);
    expect(onlyType).toContain(b.id);
    expect(onlyType).not.toContain(a.id);
  });

  it('S2-1: status・type の値が不正な絞り込みは 400', async () => {
    for (const q of ['status=bogus', 'type=bogus', 'status=OPEN', 'type=Note']) {
      const res = await getComments(server, q);
      expect(res.status, q).toBe(400);
    }
  });

  it('S2-1: 値が空文字の絞り込み(status=、type=、path=)は、指定しなかったものとして扱う', async () => {
    await postComment(server, valid({ body: 'S2-1 空の絞り込み' }));
    const all = commentsOf(await getComments(server)).map((c) => c.id);
    expect(all.length).toBeGreaterThan(0);
    for (const q of ['status=', 'type=', 'path=', 'status=&type=&path=']) {
      const res = await getComments(server, q);
      expect(res.status, q).toBe(200);
      expect(commentsOf(res).map((c) => c.id), q).toEqual(all);
    }
  });

  describe('入力の誤りは 400 で、コメントは作られない', () => {
    const oversizeAscii = 'a'.repeat(32_769);
    const oversizeMultibyte = 'あ'.repeat(10_923); // 32,769 バイト(文字数は 32,768 未満)
    const bad: Array<[label: string, payload: unknown]> = [
      ['path の欠落', (() => { const p = valid(); delete p.path; return p; })()],
      ['startLine の欠落', (() => { const p = valid(); delete p.startLine; return p; })()],
      ['endLine の欠落', (() => { const p = valid(); delete p.endLine; return p; })()],
      ['body の欠落', (() => { const p = valid(); delete p.body; return p; })()],
      ['type の欠落', (() => { const p = valid(); delete p.type; return p; })()],
      ['type が note / instruction 以外', valid({ type: 'question' })],
      ['type が文字列でない', valid({ type: 1 })],
      ['path が文字列でない', valid({ path: 123 })],
      ['body が文字列でない', valid({ body: { text: 'x' } })],
      ['startLine が文字列', valid({ startLine: '1' })],
      ['startLine が小数', valid({ startLine: 1.5 })],
      ['startLine が 0', valid({ startLine: 0 })],
      ['startLine が負', valid({ startLine: -1 })],
      ['startLine が endLine より大きい', valid({ startLine: 3, endLine: 2 })],
      ['endLine がファイルの行数を超える', valid({ startLine: 1, endLine: 100_000 })],
      ['author を含む(human)', valid({ author: 'human' })],
      ['author を含む(ai)', valid({ author: 'ai' })],
      ['未知のフィールド', valid({ extra: 1 })],
      ['quote を含む(サーバーが作る)', valid({ quote: 'x' })],
      ['docHash を含む(サーバーが作る)', valid({ docHash: 'abc' })],
      ['本文が空', valid({ body: '' })],
      ['本文が空白文字だけ(スペース)', valid({ body: '   ' })],
      ['本文が空白文字だけ(改行とタブ)', valid({ body: ' \n\t \r\n ' })],
      ['本文が 32 KiB 超(ASCII)', valid({ body: oversizeAscii })],
      ['本文が 32 KiB 超(UTF-8 で 32,769 バイト)', valid({ body: oversizeMultibyte })],
      ['JSON でない', '{not json'],
      ['JSON が配列', '[]'],
      ['JSON が null', 'null'],
      ['巨大ファイルへのコメント', valid({ path: 'large-file.txt' })],
      ['バイナリファイルへのコメント', valid({ path: 'image.png' })],
    ];
    it.each(bad)('S2-1: %s', async (_label, payload) => {
      const before = await countAll();
      const res = await postComment(server, payload);
      expect(res.status, res.text).toBe(400);
      expect(await countAll(), '拒否したのにコメントが増えた').toBe(before);
    });
  });

  it('S2-1: 本文がちょうど 32 KiB(32,768 バイト、マルチバイトを含む)は作成できる', async () => {
    const body = 'あ'.repeat(10_922) + 'aa'; // 32,768 バイト
    expect(Buffer.byteLength(body, 'utf8')).toBe(32_768);
    const res = await postComment(server, valid({ body }));
    expect(res.status, res.text.slice(0, 200)).toBe(201);
    expect(jsonOf(res).body).toBe(body);
  });

  it('S2-1: サーバーを再起動しても、コメントが残る', async () => {
    const created = jsonOf(
      await postComment(server, valid({ body: 'S2-1 永続: 再起動後も残る', startLine: 1, endLine: 2, type: 'instruction' }))
    );
    const before = commentsOf(await getComments(server));
    await server.restart();
    const after = commentsOf(await getComments(server));
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    const found = after.find((c) => c.id === created.id);
    expect(found?.body).toBe('S2-1 永続: 再起動後も残る');
    expect(found?.type).toBe('instruction');
    expect(found?.author).toBe('human');
    expect(found?.anchor).toEqual(created.anchor);
    // 再起動後も作成できる
    const again = await postComment(server, valid({ body: '再起動後の作成' }));
    expect(again.status, again.text).toBe(201);
    expect(jsonOf(again).id).not.toBe(created.id);
  });

  it('S2-1: 保存先に comments.json ができる(SPEC §2.1)', async () => {
    const ok = await waitUntil(() => existsSync(join(server.dataDir, 'comments.json')), 5_000, 100);
    expect(ok, `${server.dataDir} に comments.json が無い`).toBe(true);
  });
});

// ─── S2-4: path の検証 ──────────────────────────────────────────────────────

describe('S2-4: path は S1-4・S1-5 と同じ規則で検証される', () => {
  /**
   * 応答に、秘密や実体のパスが含まれないことを確かめる
   * @param text 応答の本文
   * @param label 失敗時の説明
   * @returns なし
   */
  const expectNoLeak = (text: string, label: string): void => {
    expect(text, label).not.toContain(OUTSIDE_SENTINEL);
    expect(text, label).not.toContain(server.baseDir);
    for (const d of denied) expect(text, `${label}: ${d.path} の中身`).not.toContain(d.sentinel);
  };

  const formBad: Array<[label: string, path: string]> = [
    ['../ で始まる', '../outside-secret.txt'],
    ['途中に ../ を挟む', 'src/../../outside-secret.txt'],
    ['./../', './../outside-secret.txt'],
    ['存在しないディレクトリを経由する ..', 'no-such-dir/../../outside-secret.txt'],
    ['リポジトリ内に収まる .. でも要素に含む', 'src/../src/example.ts'],
    ['.. だけ', '..'],
    ['絶対パス(/etc/passwd)', '/etc/passwd'],
    ['絶対パス(リポジトリの外のファイル)', '__OUTSIDE_ABS__'],
    ['絶対パス(リポジトリ内のファイル)', '__REPO_ABS__'],
    ['NUL 文字を含む', 'src/example.ts\u0000.md'],
  ];
  it.each(formBad)('S2-4: POST は形式からリポジトリ外と分かるパスを 400 にする(%s)', async (_label, rawPath) => {
    const path = rawPath === '__OUTSIDE_ABS__'
      ? join(dirname(server.repoDir), 'outside-secret.txt')
      : rawPath === '__REPO_ABS__'
        ? join(server.repoDir, EXAMPLE)
        : rawPath;
    const before = await countAll();
    const res = await postComment(server, valid({ path }));
    expect(res.status, res.text).toBe(400);
    expectNoLeak(res.text, 'POST の応答');
    expect(await countAll()).toBe(before);
  });

  const odd: Array<[label: string, path: string]> = [
    ['%2e%2e%2f(エンコードされた文字列。ここでは文字どおりの名前)', '%2e%2e%2foutside-secret.txt'],
    ['二重エンコード', '%252e%252e%252foutside-secret.txt'],
  ];
  it.each(odd)('S2-4: POST はエスケープ風のパスでも、リポジトリ外を読まず作成しない(%s)', async (_label, path) => {
    const before = await countAll();
    const res = await postComment(server, valid({ path }));
    // 形式からリポジトリ外と分かるなら 400、存在しないファイル名なら 404
    expect([400, 404], res.text).toContain(res.status);
    expectNoLeak(res.text, 'POST の応答');
    expect(await countAll()).toBe(before);
  });

  // 正規の形でないパス(正規化せずに 400)。存在するファイルを指していても 400
  const nonCanonical: Array<[label: string, path: string]> = [
    ['先頭の ./', './src/example.ts'],
    ['空の要素 //', 'src//example.ts'],
    ['. の要素', 'src/./example.ts'],
    ['末尾の /(ファイル)', 'src/example.ts/'],
    ['末尾の /(ディレクトリ)', 'src/'],
    ['バックスラッシュ', 'src\\example.ts'],
    ['バックスラッシュで ..', '..\\outside-secret.txt'],
    ['先頭の //', '//src/example.ts'],
  ];
  it.each(nonCanonical)('S2-4: POST は正規の形でないパスを正規化せずに 400 にする(%s)', async (_label, path) => {
    const before = await countAll();
    const res = await postComment(server, valid({ path }));
    expect(res.status, res.text).toBe(400);
    expect(await countAll()).toBe(before);
  });

  it.each(['subdir', 'src'])('S2-4: POST はディレクトリを指す path(%s)を 404 にする', async (path) => {
    const before = await countAll();
    const res = await postComment(server, valid({ path }));
    expect(res.status, res.text).toBe(404);
    expect(await countAll()).toBe(before);
  });

  const deniedPaths: Array<[label: string, path: string]> = [
    ...denied.map((d): [string, string] => [d.reason + ' → ' + d.path, d.path]),
    ['存在しないパス', 'no/such/file.ts'],
    ['存在しないパス(ルート直下)', 'no-such-file.ts'],
    ['リポジトリ外を指すシンボリックリンク(絶対)', 'link-abs-file.txt'],
    ['リポジトリ外を指すシンボリックリンク(相対)', 'link-rel-file.txt'],
    ['リポジトリ外を指すシンボリックリンク(ディレクトリ経由)', 'link-dir/inner.txt'],
    ['リポジトリ外を指すシンボリックリンク(多段)', 'link-chain.txt'],
    ['リポジトリ外を指すシンボリックリンク(サブディレクトリ内)', 'src/link-in-subdir.ts'],
  ];
  it.each(deniedPaths)('S2-4: POST は拒否対象・存在しないパスを 404 にし、コメントを作らない(%s)', async (_label, path) => {
    const before = await countAll();
    const res = await postComment(server, valid({ path }));
    expect(res.status, res.text).toBe(404);
    expectNoLeak(res.text, 'POST の応答');
    // パスがエコーされてもパス名自体には当たらないように、パスを除いてから調べる
    expect(res.text.replaceAll(path, '<PATH>'), '応答に拒否の理由を載せない').not.toMatch(
      /gitignore|secret|symlink|symbolic|outside/i
    );
    expect(await countAll()).toBe(before);
  });

  it('S2-4: 拒否した POST の応答は、存在しないパスの応答と区別できない(パスのエコーを除く)', async () => {
    const norm = (text: string, path: string): string => text.replaceAll(path, '<PATH>');
    const ref = await postComment(server, valid({ path: 'no/such/file.ts' }));
    expect(ref.status).toBe(404);
    for (const path of ['.env', 'excluded-by-git.txt', 'link-abs-file.txt', 'secret.pem']) {
      const res = await postComment(server, valid({ path }));
      expect(res.status, path).toBe(404);
      expect(norm(res.text, path), path).toBe(norm(ref.text, 'no/such/file.ts'));
      expect(res.headers['content-type'], path).toBe(ref.headers['content-type']);
    }
  });

  describe('GET /api/comments?path= は文字列の比較だけで絞り、拒否対象も区別しない', () => {
    const emptyPaths: Array<[label: string, path: string]> = [
      ['存在しないパス', 'no/such/file.ts'],
      ['.env', '.env'],
      ['.git/config', '.git/config'],
      ['*.pem', 'secret.pem'],
      ['.gitignore の対象', 'excluded-by-git.txt'],
      ['.gitignore の対象(ディレクトリ配下)', 'build-out/artifact.txt'],
      ['リポジトリ外を指すシンボリックリンク(絶対)', 'link-abs-file.txt'],
      ['リポジトリ外を指すシンボリックリンク(相対)', 'link-rel-file.txt'],
      ['リポジトリ外を指すシンボリックリンク(ディレクトリ経由)', 'link-dir/inner.txt'],
    ];
    let reference: { text: string; contentType: unknown } | undefined;

    it.each(emptyPaths)('S2-4: 200 と空の一覧を返す(%s)', async (_label, path) => {
      const res = await getComments(server, `path=${encodeURIComponent(path)}`);
      expect(res.status, res.text).toBe(200);
      expect(commentsOf(res)).toEqual([]);
      expectNoLeak(res.text, 'GET の応答');
    });

    it('S2-4: 拒否対象と存在しないパスの応答は、本文もヘッダ(content-type)も同じ', async () => {
      const ref = await getComments(server, 'path=no%2Fsuch%2Ffile.ts');
      reference = { text: ref.text, contentType: ref.headers['content-type'] };
      expect(ref.status).toBe(200);
      for (const [label, path] of emptyPaths) {
        const res = await getComments(server, `path=${encodeURIComponent(path)}`);
        expect(res.status, label).toBe(200);
        expect(res.text, label).toBe(reference.text);
        expect(res.headers['content-type'], label).toBe(reference.contentType);
      }
    });

    const badForm: Array<[label: string, query: string]> = [
      ['../', 'path=..%2Foutside-secret.txt'],
      ['途中に ..', 'path=src%2F..%2F..%2Foutside-secret.txt'],
      ['.. だけ', 'path=..'],
      ['..%2f(エンコードされた /)', 'path=..%2foutside-secret.txt'],
      ['絶対パス', 'path=%2Fetc%2Fpasswd'],
      ['NUL 文字', 'path=src%2Fexample.ts%00.md'],
    ];
    it.each(badForm)('S2-4: 形式からリポジトリ外と分かるパスは 400(%s)', async (_label, query) => {
      const res = await getComments(server, query);
      expect(res.status, res.text).toBe(400);
      expectNoLeak(res.text, 'GET の応答');
    });

    it.each(nonCanonical)('S2-4: 正規の形でないパスの絞り込みは 400(%s)', async (_label, path) => {
      const res = await getComments(server, `path=${encodeURIComponent(path)}`);
      expect(res.status, res.text).toBe(400);
    });

    it('S2-4: 正常なパスで作成済みのコメントは見つかる', async () => {
      const created = jsonOf(await postComment(server, valid({ path: 'subdir/normal.ts', body: 'S2-4 見つかる' })));
      const res = await getComments(server, 'path=subdir%2Fnormal.ts');
      expect(res.status).toBe(200);
      expect(commentsOf(res).map((c) => c.id)).toContain(created.id);
    });
  });
});

// ─── C-2・C-5: POST /api/comments への回帰 ──────────────────────────────────

describe('C-2: POST /api/comments の Origin 検証', () => {
  it('C-2: Origin が許可リスト外なら 403 で、コメントは作られない', async () => {
    const before = await countAll();
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${server.port + 1}`, 'http://localhost.evil.example']) {
      const res = await postComment(server, valid(), { Origin: origin });
      expect(res.status, `Origin: ${origin}`).toBe(403);
    }
    expect(await countAll()).toBe(before);
  });

  it('C-2: 許可された Origin + JSON なら作成できる', async () => {
    const res = await postComment(server, valid({ body: 'C-2 許可 Origin' }), { Origin: `http://127.0.0.1:${server.port}` });
    expect(res.status, res.text).toBe(201);
  });

  it('C-2: Origin が無くても、Content-Type が JSON なら作成できる', async () => {
    const res = await postComment(server, valid({ body: 'C-2 Origin なし' }));
    expect(res.status, res.text).toBe(201);
  });

  it('C-2: Origin が無く、Content-Type が JSON でないなら 403 で、コメントは作られない', async () => {
    const before = await countAll();
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await postComment(server, valid(), { 'Content-Type': ct });
      expect(res.status, ct).toBe(403);
    }
    expect(await countAll()).toBe(before);
  });
});

describe('C-5: コメント API の応答とログに秘密を出さない', () => {
  it('C-5: 秘密に見えるファイルへのコメントは拒否され、応答とログに中身・トークンが出ない', async () => {
    const texts: string[] = [];
    for (const d of denied) {
      const res = await postComment(server, valid({ path: d.path }));
      expect(res.status, d.path).toBe(404);
      texts.push(res.text, JSON.stringify(res.headers));
      const list = await getComments(server, `path=${encodeURIComponent(d.path)}`);
      texts.push(list.text, JSON.stringify(list.headers));
    }
    const res = await request(server, '/api/comments?status=bogus');
    texts.push(res.text);
    const joined = texts.join('\n') + '\n' + server.logs();
    for (const d of denied) expect(joined, d.path).not.toContain(d.sentinel);
    expect(joined).not.toContain(OUTSIDE_SENTINEL);
    expect(joined).not.toContain(DUMMY_TOKEN);
  });
});
