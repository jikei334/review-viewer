/**
 * サーバーの設定の読み込み(SPEC §2.5 の環境変数)
 *
 * 副作用のない関数だけを置く。環境変数は引数で受け取り、`process.env` を直接読まない
 * (単体テストで既定値と境界条件を確かめるため)。
 *
 * `REVIEW_VIEWER_TOKEN` はステージ3(MCP)で使う。ここでは読まないし、設定にも載せない
 * (C-5: 秘密を、ログやエラーに出す経路へ持ち込まない)。
 */

/** サーバーの設定 */
export interface ServerConfig {
  /** 対象リポジトリのディレクトリ(読み取り専用として扱う) */
  readonly repoDir: string;
  /** コメントの保存先のディレクトリ */
  readonly dataDir: string;
  /** bind アドレス */
  readonly host: string;
  /** ポート番号 */
  readonly port: number;
  /** 許可する `Host` ヘッダ(小文字に揃えてある) */
  readonly allowedHosts: readonly string[];
  /** 許可する `Origin` ヘッダ(小文字に揃えてある) */
  readonly allowedOrigins: readonly string[];
}

/** 環境変数の入れ物(`process.env` と同じ形) */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** `REPO_DIR` の既定値 */
export const DEFAULT_REPO_DIR = '/repo';
/** `DATA_DIR` の既定値 */
export const DEFAULT_DATA_DIR = '/data';
/** `HOST` の既定値。`0.0.0.0` を既定にしない(C-3) */
export const DEFAULT_HOST = '127.0.0.1';
/** `PORT` の既定値 */
export const DEFAULT_PORT = 3000;

/** 設定の値が不正なときのエラー。メッセージには、環境変数の名前と理由だけを入れる */
export class ConfigError extends Error {
  /**
   * @param message 不正な環境変数の名前と、その理由
   */
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 環境変数の値を取り出す。未設定と、空白だけの値は、同じ「未設定」として扱う
 *
 * @param env 環境変数
 * @param name 環境変数の名前
 * @returns 前後の空白を除いた値。未設定または空なら undefined
 */
function readEnv(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * ポート番号の文字列を数値にする
 *
 * @param value `PORT` の値(未設定なら undefined)
 * @returns 1〜65535 の整数。未設定なら既定値
 * @throws ConfigError 10進の整数でない、または範囲外のとき
 */
export function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  // 符号・小数・指数・16進などを通さないように、数字だけの並びに限る
  if (!/^\d{1,5}$/.test(value)) {
    throw new ConfigError('PORT は 1〜65535 の整数で指定してください');
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new ConfigError('PORT は 1〜65535 の整数で指定してください');
  }
  return port;
}

/**
 * カンマ区切りの許可リストを配列にする
 *
 * 各要素は、前後の空白を除き、小文字に揃える。空の要素は捨てる。
 *
 * @param value カンマ区切りの文字列
 * @returns 許可リスト(重複は除く)
 */
export function parseAllowList(value: string): string[] {
  const items = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
  return [...new Set(items)];
}

/**
 * 環境変数からサーバーの設定を組み立てる(SPEC §2.5)
 *
 * @param env 環境変数(`process.env` を渡す)
 * @returns サーバーの設定。未設定の項目は SPEC §2.5 の既定値
 * @throws ConfigError 値が不正なとき
 */
export function loadConfig(env: EnvSource): ServerConfig {
  const port = parsePort(readEnv(env, 'PORT'));

  const allowedHosts = parseAllowList(
    readEnv(env, 'ALLOWED_HOSTS') ?? `127.0.0.1:${port},localhost:${port}`
  );
  const allowedOrigins = parseAllowList(
    readEnv(env, 'ALLOWED_ORIGINS') ?? `http://127.0.0.1:${port},http://localhost:${port}`
  );
  // 「,」だけのような値は、要素が1つも残らない。すべてのリクエストを拒否する状態で
  // 黙って起動するより、設定の誤りとして止める
  if (allowedHosts.length === 0) {
    throw new ConfigError('ALLOWED_HOSTS に、許可する Host が1つもありません');
  }
  if (allowedOrigins.length === 0) {
    throw new ConfigError('ALLOWED_ORIGINS に、許可する Origin が1つもありません');
  }

  return {
    repoDir: readEnv(env, 'REPO_DIR') ?? DEFAULT_REPO_DIR,
    dataDir: readEnv(env, 'DATA_DIR') ?? DEFAULT_DATA_DIR,
    host: readEnv(env, 'HOST') ?? DEFAULT_HOST,
    port,
    allowedHosts,
    allowedOrigins,
  };
}
