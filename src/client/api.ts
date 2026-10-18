/**
 * サーバーの Web API(SPEC §2.2)を呼ぶ関数
 *
 * 応答の形を検証してから返す(想定外の応答を、そのまま画面に流さない)。
 */

/** レポート一覧の1件 */
export interface ReportSummary {
  /** ファイル名 */
  readonly name: string;
  /** リポジトリ相対パス */
  readonly path: string;
  /** 更新日時(ISO 8601) */
  readonly modifiedAt: string;
}

/** ファイルの内容(本文があるのは kind=text のときだけ) */
export type FileResult =
  | { readonly kind: 'text'; readonly path: string; readonly content: string }
  | { readonly kind: 'too_large'; readonly path: string }
  | { readonly kind: 'binary'; readonly path: string };

/** API の呼び出しに失敗したときのエラー(メッセージに URL やパスを含めない) */
export class ApiError extends Error {
  /**
   * @param message 失敗の内容
   * @param status HTTP ステータス(応答を受け取れなかったときは 0)
   * @param options 元のエラー(cause)
   */
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ApiError';
  }
}

/**
 * 値がオブジェクトかを調べる
 *
 * @param value 調べる値
 * @returns オブジェクト(null と配列を除く)なら true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * GET リクエストを送り、JSON として読む
 *
 * @param url リクエスト先(同一オリジンのパス)
 * @returns 解析した JSON
 * @throws ApiError 通信に失敗した、200 以外が返った、JSON として読めなかったとき
 */
async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new ApiError('サーバーに接続できません', 0, { cause: err });
  }
  if (!res.ok) throw new ApiError(`サーバーがエラーを返しました(${res.status})`, res.status);
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new ApiError('サーバーの応答を読めません', res.status);
  }
}

/**
 * レポートの一覧を取得する(新しい順。並べ替えはサーバーが行う)
 *
 * @returns レポートの一覧
 * @throws ApiError 取得に失敗した、または応答の形が想定と違うとき
 */
export async function fetchReports(): Promise<ReportSummary[]> {
  const body = await getJson('/api/reports');
  if (!isRecord(body) || !Array.isArray(body.reports)) {
    throw new ApiError('レポート一覧の形式が想定と違います', 200);
  }
  return body.reports.map((item: unknown): ReportSummary => {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.path !== 'string' ||
      typeof item.modifiedAt !== 'string'
    ) {
      throw new ApiError('レポート一覧の形式が想定と違います', 200);
    }
    return { name: item.name, path: item.path, modifiedAt: item.modifiedAt };
  });
}

/**
 * ファイルの内容を取得する
 *
 * @param path リポジトリ相対パス
 * @returns ファイルの内容(巨大・バイナリは本文なし)
 * @throws ApiError 取得に失敗した、または応答の形が想定と違うとき
 */
export async function fetchFile(path: string): Promise<FileResult> {
  const body = await getJson(`/api/file?path=${encodeURIComponent(path)}`);
  if (!isRecord(body) || typeof body.path !== 'string') {
    throw new ApiError('ファイルの形式が想定と違います', 200);
  }
  if (body.kind === 'text' && typeof body.content === 'string') {
    return { kind: 'text', path: body.path, content: body.content };
  }
  if (body.kind === 'too_large' || body.kind === 'binary') {
    return { kind: body.kind, path: body.path };
  }
  throw new ApiError('ファイルの形式が想定と違います', 200);
}

/** ディレクトリ一覧の1件 */
export interface TreeEntry {
  /** 名前 */
  readonly name: string;
  /** リポジトリ相対パス */
  readonly path: string;
  /** 種類 */
  readonly type: 'file' | 'directory';
}

/**
 * ディレクトリの一覧を取得する
 *
 * @param path リポジトリ相対パス(ルートは空文字列)
 * @returns 配下の一覧(ディレクトリが先、名前の昇順。並べ替えはサーバーが行う)
 * @throws ApiError 取得に失敗した、または応答の形が想定と違うとき
 */
export async function fetchTree(path: string): Promise<TreeEntry[]> {
  const body = await getJson(`/api/tree?path=${encodeURIComponent(path)}`);
  if (!isRecord(body) || !Array.isArray(body.entries)) {
    throw new ApiError('ツリーの形式が想定と違います', 200);
  }
  return body.entries.map((item: unknown): TreeEntry => {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      typeof item.path !== 'string' ||
      (item.type !== 'file' && item.type !== 'directory')
    ) {
      throw new ApiError('ツリーの形式が想定と違います', 200);
    }
    return { name: item.name, path: item.path, type: item.type };
  });
}
