/**
 * Hono アプリの組み立て
 *
 * ここは薄いアダプタ。検証の規則は request-guard.ts(純粋関数)に、業務ロジックは
 * ReviewService に、ファイルの読み取りは RepoReader に置く。このファイルは `fs` に触れない。
 * 起動やシグナル処理などの副作用は持たない(テストから import して使えるようにする)。
 */
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ServerConfig } from './config.js';
import { InputError, parseCommentFilter, parseCreateCommentInput } from './comment-input.js';
import { parseReplyInput, parseUpdateCommentInput } from './comment-status.js';
import { RepoAccessError, type RepoAccessCode } from './path-policy.js';
import { RepoReader } from './RepoReader.js';
import { checkRequest } from './request-guard.js';
import { ReviewService } from './ReviewService.js';
import { CommentNotFoundError, ReviewStore, StoreClosingError } from './ReviewStore.js';
import type { StaticAssets } from './static-assets.js';

/** アプリの組み立てに必要な設定(許可リストと、対象リポジトリと、保存先) */
export type AppConfig = Pick<ServerConfig, 'allowedHosts' | 'allowedOrigins' | 'repoDir'> &
  Partial<Pick<ServerConfig, 'dataDir'>>;

/** ログの出力先(1行分の文字列を受け取る) */
export type AppLogger = (message: string) => void;

/** アプリが使うもの(省略したものは、設定から作る。テストで差し替えるためにある) */
export interface AppDeps {
  /**
   * 業務ロジック。省略時は、`config.repoDir` を読む RepoReader と、`config.dataDir` の ReviewStore で作る
   * (この ReviewStore は読み込んでいないので、コメントの API は失敗する。起動の入口は、読み込み済みのものを渡す)
   */
  readonly service?: Pick<
    ReviewService,
    'listReports' | 'listTree' | 'getFile' | 'createComment' | 'listComments' | 'assertCommentExists' | 'updateComment' | 'addReply'
  >;
  /** ログの出力先。省略時は標準エラー */
  readonly log?: AppLogger;
  /** 画面の静的ファイルの配信元。省略時は、画面を配信しない(`GET /` は 404) */
  readonly assets?: StaticAssets;
}

/**
 * すべての応答に付ける Content-Security-Policy
 *
 * 画面は同一オリジンのスクリプトだけを実行する(インラインのスクリプト、eval、外部サイトのスクリプトは不可)。
 * `style-src 'unsafe-inline'` は、Mermaid の図(SVG)が <style> 要素を含むために必要で、
 * スクリプトの実行には影響しない。画像は自分自身と data: だけ(外部への送信に使わせない)。
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * パスを受け付けられないときの、HTTP ステータス
 *
 * 暫定の方針: 拒否(リポジトリの外、秘密ファイル、`.gitignore` の対象)は、存在しないパスと
 * 区別できないように、どちらも 404。形式が正しくないパスだけ 400。
 */
const ACCESS_STATUS: Readonly<Record<RepoAccessCode, 400 | 404>> = {
  invalid_path: 400,
  not_found: 404,
};

/** ログに出してよい、エラーの名前の形(クラス名として普通の文字だけ) */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** ログに出してよい、エラーコードの形(`ENOENT`、`ERR_INVALID_ARG_TYPE` など) */
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** ログに出してよい、HTTP メソッドの形 */
const SAFE_METHOD = /^[A-Z]{1,16}$/;
/** ログに出してよい、リクエストのパスの形(このアプリのルートに使う文字だけ) */
const SAFE_REQUEST_PATH = /^\/[A-Za-z0-9/_-]{0,100}$/;

/**
 * Error でない値(文字列など)が投げられたことを表すエラー
 *
 * 投げられた値は持たない(中身が分からないものを、ログや応答へ運ばないため)。
 */
export class NonErrorThrownError extends Error {
  constructor() {
    super('Error でない値が投げられました');
    this.name = 'NonErrorThrownError';
  }
}

/**
 * 捕まえた値から、ログに出してよいエラーコードを取り出す
 *
 * @param err 捕まえた値
 * @returns エラーコード。無い、または形が想定外なら undefined
 */
function safeErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const code = err.code;
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : undefined;
}

/**
 * エラーを、ログに出してよい範囲に絞った文字列にする(C-5、CLAUDE.md ルール8)
 *
 * 出すのは、エラーの名前と、エラーコード(と、原因のエラーコード)だけ。
 * **メッセージとスタックは出さない。** Node.js のファイル操作のエラーは、メッセージに
 * 実体のパス(リポジトリの外のパスを含む)を載せるし、ほかのエラーも、ファイルの中身を
 * メッセージに含めることがあるため。
 *
 * @param err 捕まえた値
 * @returns `名前` または `名前 (code=…, cause=…)` の形の文字列
 */
export function summarizeErrorForLog(err: unknown): string {
  const name = err instanceof Error && SAFE_ERROR_NAME.test(err.name) ? err.name : 'Error';
  const details: string[] = [];
  const code = safeErrorCode(err);
  if (code !== undefined) details.push(`code=${code}`);
  const causeCode = err instanceof Error ? safeErrorCode(err.cause) : undefined;
  if (causeCode !== undefined) details.push(`cause=${causeCode}`);
  return details.length === 0 ? name : `${name} (${details.join(', ')})`;
}

/**
 * ログを1行、標準エラーへ出す(ログの出力先を省略したときの既定)
 *
 * @param message 出力する文字列
 * @returns なし
 */
function logToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * クエリの `path` を取り出す
 *
 * 省略と空は、どちらも空文字列(リポジトリのルート。SPEC §2.2)。
 * `path` が2つ以上あるリクエストは、どれを検証したのかが曖昧になるので受け付けない。
 * URL のデコードは、Hono が1回だけ行う(ここで追加のデコードはしない)。
 *
 * @param c リクエストのコンテキスト
 * @returns `path` の値
 * @throws RepoAccessError `path` が2つ以上あるとき(`invalid_path`)
 */
function readPathQuery(c: Context): string {
  const values = c.req.queries('path') ?? [];
  if (values.length > 1) throw new RepoAccessError('invalid_path', 'malformed');
  return values[0] ?? '';
}

/**
 * クエリの値を1つだけ取り出す(省略は undefined)
 *
 * 同じ名前が2つ以上あるリクエストは、どれを検証したのかが曖昧になるので受け付けない。
 *
 * @param c リクエストのコンテキスト
 * @param name クエリの名前
 * @returns 値。省略なら undefined
 * @throws InputError 2つ以上あるとき
 */
function readSingleQuery(c: Context, name: string): string | undefined {
  const values = c.req.queries(name) ?? [];
  if (values.length > 1) throw new InputError('クエリが重複しています');
  return values[0];
}

/**
 * リクエストの本文を JSON として読む
 *
 * @param c リクエストのコンテキスト
 * @returns パースした値
 * @throws InputError 本文を読めない、または JSON でないとき(本文の内容はエラーに含めない)
 */
async function readJsonBody(c: Context): Promise<unknown> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw new InputError('リクエストの本文を読めません');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError('リクエストの本文が JSON ではありません');
  }
}

/**
 * Hono アプリを組み立てる
 *
 * Host / Origin の検証は、最初のミドルウェアとして、すべてのパスとメソッドに掛ける
 * (存在しないルートも対象。ルートの有無で応答を変えない)。
 *
 * @param config 許可リストと、対象リポジトリのディレクトリ
 * @param deps 業務ロジックとログの出力先(省略可。テストで差し替える)
 * @returns 組み立てた Hono アプリ
 */
export function createApp(config: AppConfig, deps: AppDeps = {}): Hono {
  const app = new Hono();
  const log = deps.log ?? logToStderr;
  const service =
    deps.service ??
    new ReviewService({
      repoReader: new RepoReader({ repoDir: config.repoDir }),
      store: new ReviewStore({ dataDir: config.dataDir ?? '' }),
    });

  app.use('*', async (c, next) => {
    // 応答の種類を、ブラウザに中身から推測させない(JSON を HTML として解釈させない。S1-7)
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    c.header('Referrer-Policy', 'no-referrer');
    // X-Forwarded-Host や Forwarded は見ない。信用するのは Host ヘッダだけ(C-1)
    const result = checkRequest(
      {
        method: c.req.method,
        host: c.req.header('host'),
        origin: c.req.header('origin'),
        contentType: c.req.header('content-type'),
      },
      config
    );
    if (!result.ok) {
      // 応答には固定の理由だけを載せる。受け取ったヘッダの値は返さない(C-5)
      return c.json({ error: 'forbidden', reason: result.reason }, 403);
    }
    try {
      await next();
    } catch (err) {
      if (err instanceof Error) throw err;
      // Hono は、Error でない値が投げられると onError を呼ばずに、そのまま外へ投げ直す。
      // 記録されないまま 500 になるのを避けるため、Error に包んで onError に渡す。
      // 投げられた値そのものは、中身が分からないので、ログにも応答にも出さない(C-5)
      throw new NonErrorThrownError();
    }
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // 以下の応答は、すべて JSON(application/json)。ファイルの本文も、JSON の文字列として返す
  app.get('/api/reports', async (c) => c.json({ reports: await service.listReports() }));
  app.get('/api/tree', async (c) => c.json(await service.listTree(readPathQuery(c))));
  app.get('/api/file', async (c) => c.json(await service.getFile(readPathQuery(c))));

  // コメント。応答・ログに本文やパスの実体を出さない(C-5)。Web からのコメントは author=human 固定
  app.post('/api/comments', async (c) => {
    const input = parseCreateCommentInput(await readJsonBody(c));
    return c.json(await service.createComment(input, 'human'), 201);
  });
  app.get('/api/comments', (c) => {
    const filter = parseCommentFilter({
      path: readSingleQuery(c, 'path'),
      status: readSingleQuery(c, 'status'),
      type: readSingleQuery(c, 'type'),
    });
    return c.json({ comments: service.listComments(filter) });
  });

  // ステータス変更と返信。存在しない id は、内容の誤りより先に 404 にする(SPEC §2.2)。
  // 人間のコメントの本文を編集・削除する API は無い(PATCH で body が来たら 400)
  app.patch('/api/comments/:id', async (c) => {
    const id = c.req.param('id');
    service.assertCommentExists(id);
    const input = parseUpdateCommentInput(await readJsonBody(c));
    return c.json(await service.updateComment(id, input));
  });
  app.post('/api/comments/:id/replies', async (c) => {
    const id = c.req.param('id');
    service.assertCommentExists(id);
    const input = parseReplyInput(await readJsonBody(c));
    return c.json(await service.addReply(id, input, 'human'), 201);
  });

  // 画面の静的ファイル(GET のみ。対応表に無いパスは 404)。API のルートより後に置く
  const assets = deps.assets;
  if (assets !== undefined) {
    app.get('*', async (c) => {
      const asset = await assets.read(c.req.path);
      if (asset === undefined) return c.notFound();
      c.header('Content-Type', asset.contentType);
      c.header('Cache-Control', asset.cacheControl);
      return c.body(asset.body as Uint8Array<ArrayBuffer>);
    });
  }

  // Hono の既定の onError は、例外を console.error でそのまま出す(メッセージとスタックに、
  // 実体のパスなどが入る)。ログと応答に出す内容を、ここで絞る(C-5、CLAUDE.md ルール8)
  app.onError((err, c) => {
    if (err instanceof RepoAccessError) {
      // 応答に載せるのは、固定の分類だけ。指定されたパス、実体のパス、拒否の理由は載せない
      // (秘密ファイルが存在するかどうかを、応答の違いから調べられないようにする)
      return c.json({ error: err.code }, ACCESS_STATUS[err.code]);
    }
    if (err instanceof CommentNotFoundError) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (err instanceof StoreClosingError) {
      // 終了処理中。固定の応答だけを返す(保存はしていない)
      return c.json({ error: 'shutting_down' }, 503);
    }
    if (err instanceof InputError) {
      // メッセージは固定の文字列(受け取った値を含まない)
      return c.json({ error: 'invalid_input', message: err.message }, 400);
    }
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    // クエリ(利用者が指定したパス)は出さない。パスも、想定した形のときだけ出す
    const method = SAFE_METHOD.test(c.req.method) ? c.req.method : '(省略)';
    const requestPath = SAFE_REQUEST_PATH.test(c.req.path) ? c.req.path : '(省略)';
    log(
      `Review Viewer: リクエストの処理に失敗しました: ${method} ${requestPath}: ${summarizeErrorForLog(err)}`
    );
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
