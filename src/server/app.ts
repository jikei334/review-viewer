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
import { RepoAccessError, type RepoAccessCode } from './path-policy.js';
import { RepoReader } from './RepoReader.js';
import { checkRequest } from './request-guard.js';
import { ReviewService } from './ReviewService.js';

/** アプリの組み立てに必要な設定(許可リストと、対象リポジトリ) */
export type AppConfig = Pick<ServerConfig, 'allowedHosts' | 'allowedOrigins' | 'repoDir'>;

/** ログの出力先(1行分の文字列を受け取る) */
export type AppLogger = (message: string) => void;

/** アプリが使うもの(省略したものは、設定から作る。テストで差し替えるためにある) */
export interface AppDeps {
  /** 業務ロジック。省略時は、`config.repoDir` を読む RepoReader で作る */
  readonly service?: Pick<ReviewService, 'listReports' | 'listTree' | 'getFile'>;
  /** ログの出力先。省略時は標準エラー */
  readonly log?: AppLogger;
}

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
    deps.service ?? new ReviewService({ repoReader: new RepoReader({ repoDir: config.repoDir }) });

  app.use('*', async (c, next) => {
    // 応答の種類を、ブラウザに中身から推測させない(JSON を HTML として解釈させない。S1-7)
    c.header('X-Content-Type-Options', 'nosniff');
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

  // Hono の既定の onError は、例外を console.error でそのまま出す(メッセージとスタックに、
  // 実体のパスなどが入る)。ログと応答に出す内容を、ここで絞る(C-5、CLAUDE.md ルール8)
  app.onError((err, c) => {
    if (err instanceof RepoAccessError) {
      // 応答に載せるのは、固定の分類だけ。指定されたパス、実体のパス、拒否の理由は載せない
      // (秘密ファイルが存在するかどうかを、応答の違いから調べられないようにする)
      return c.json({ error: err.code }, ACCESS_STATUS[err.code]);
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
