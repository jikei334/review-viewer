/**
 * リクエストの検証(C-1: Host、C-2: Origin / Content-Type)
 *
 * 副作用のない関数だけを置く。HTTP の枠組み(Hono)には依存しない。
 *
 * 比較は、許可リストの要素との**完全一致**だけで行う。前方一致・後方一致・部分一致や、
 * ワイルドカードは使わない(`127.0.0.1:3000.evil.com` や `evil-localhost:3000` を通さないため)。
 * 大文字小文字だけは区別しない(ホスト名とスキームは、もともと大文字小文字を区別しないため。
 * 許可リストの側は、設定の読み込みで小文字に揃えてある)。
 */

/** 状態を変更しないメソッド。これ以外は、すべて「状態を変更するリクエスト」として扱う */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 拒否の理由(応答に載せてよい、固定の文字列) */
export type RejectReason = 'host_not_allowed' | 'origin_not_allowed' | 'content_type_not_json';

/** 検証の結果 */
export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly reason: RejectReason };

/** 検証に使う、リクエストの一部 */
export interface GuardedRequest {
  /** HTTP メソッド */
  readonly method: string;
  /** `Host` ヘッダの値(無ければ undefined) */
  readonly host: string | undefined;
  /** `Origin` ヘッダの値(無ければ undefined) */
  readonly origin: string | undefined;
  /** `Content-Type` ヘッダの値(無ければ undefined) */
  readonly contentType: string | undefined;
}

/** 許可リスト */
export interface GuardPolicy {
  /** 許可する `Host` ヘッダ(小文字) */
  readonly allowedHosts: readonly string[];
  /** 許可する `Origin` ヘッダ(小文字) */
  readonly allowedOrigins: readonly string[];
}

/**
 * ヘッダの値が、許可リストのいずれかと完全一致するかを調べる(大文字小文字は区別しない)
 *
 * @param value ヘッダの値(無ければ undefined)
 * @param allowed 許可リスト(小文字)
 * @returns 一致すれば true。値が無い、または空なら false
 */
function matchesAllowList(value: string | undefined, allowed: readonly string[]): boolean {
  if (value === undefined || value === '') return false;
  return allowed.includes(value.toLowerCase());
}

/**
 * `Host` ヘッダが許可リストにあるかを調べる(C-1)
 *
 * @param host `Host` ヘッダの値(無ければ undefined)
 * @param allowedHosts 許可する `Host`(小文字。`ホスト名:ポート` の形)
 * @returns 許可リストのいずれかと完全一致すれば true
 */
export function isHostAllowed(host: string | undefined, allowedHosts: readonly string[]): boolean {
  return matchesAllowList(host, allowedHosts);
}

/**
 * `Origin` ヘッダが許可リストにあるかを調べる(C-2)
 *
 * `null`(サンドボックス化された iframe など)は、許可リストに無いので拒否になる。
 *
 * @param origin `Origin` ヘッダの値(無ければ undefined)
 * @param allowedOrigins 許可する `Origin`(小文字。`スキーム://ホスト名:ポート` の形)
 * @returns 許可リストのいずれかと完全一致すれば true
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[]
): boolean {
  return matchesAllowList(origin, allowedOrigins);
}

/**
 * 状態を変更するメソッドかどうかを調べる
 *
 * SPEC C-2 が挙げる POST / PATCH / DELETE に加えて、GET / HEAD / OPTIONS 以外は
 * すべて対象にする(PUT などを、検証なしで通さないため)。
 *
 * @param method HTTP メソッド
 * @returns 状態を変更するメソッドなら true
 */
export function isStateChangingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * `Content-Type` が JSON(`application/json`)かどうかを調べる
 *
 * パラメータ(`; charset=utf-8` など)は無視して、メディアタイプだけを比べる。
 * `text/plain; application/json` のように、JSON という文字列を含むだけの値は JSON ではない。
 * `application/*+json` は対象にしない(このアプリが受け付けるのは `application/json` だけ)。
 *
 * @param contentType `Content-Type` ヘッダの値(無ければ undefined)
 * @returns メディアタイプが `application/json` なら true
 */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const mediaType = contentType.split(';', 1)[0] ?? '';
  return mediaType.trim().toLowerCase() === 'application/json';
}

/**
 * リクエストを通してよいかを判定する(C-1、C-2)
 *
 * 1. `Host` が許可リスト外なら拒否(すべてのメソッド)
 * 2. 状態を変更するメソッドで、`Origin` があり、許可リスト外なら拒否
 * 3. 状態を変更するメソッドで、`Origin` が無く、`Content-Type` が JSON でないなら拒否
 *
 * @param request 検証するリクエストの一部
 * @param policy 許可リスト
 * @returns 通してよければ `{ ok: true }`。拒否なら、その理由
 */
export function checkRequest(request: GuardedRequest, policy: GuardPolicy): GuardResult {
  if (!isHostAllowed(request.host, policy.allowedHosts)) {
    return { ok: false, reason: 'host_not_allowed' };
  }
  if (!isStateChangingMethod(request.method)) {
    return { ok: true };
  }
  // 空の Origin ヘッダ(`Origin:`)は「無い」ではなく「ある」として扱い、許可リスト外で拒否する
  if (request.origin !== undefined) {
    return isOriginAllowed(request.origin, policy.allowedOrigins)
      ? { ok: true }
      : { ok: false, reason: 'origin_not_allowed' };
  }
  return isJsonContentType(request.contentType)
    ? { ok: true }
    : { ok: false, reason: 'content_type_not_json' };
}
