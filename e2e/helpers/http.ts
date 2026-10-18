/**
 * e2e テスト用の HTTP クライアントと、応答の検査ヘルパー
 *
 * Node.js の `fetch` は `Host` ヘッダの上書きを黙って無視する(禁止ヘッダ扱い)。
 * そのため `fetch` では C-1(Host 検証)を検証できない。
 * ここでは `node:http` を直接使い、`Host` や `Origin` を任意の値で送れるようにする。
 *
 * このファイルは vitest にも src/ にも依存しない。
 */

import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';

/** リクエスト先を特定する最小限の情報 */
export interface HttpTarget {
  /** 接続先のポート番号 */
  port: number;
}

/** リクエストのオプション */
export interface RequestOptions {
  /** HTTP メソッド。既定は GET */
  method?: string;
  /**
   * 追加のヘッダ。`Host` を含めれば、その値がそのまま送られる。
   * `Host` を含めない場合は `127.0.0.1:<port>` を送る。
   */
  headers?: Record<string, string>;
  /** リクエストボディ */
  body?: string | Buffer;
  /** 接続先のアドレス。既定は 127.0.0.1 */
  address?: string;
  /** 応答を待つ上限(ミリ秒)。既定は 10 秒 */
  timeoutMs?: number;
}

/** HTTP の応答 */
export interface HttpResult {
  /** ステータスコード */
  status: number;
  /** 応答ヘッダ(名前は小文字) */
  headers: IncomingHttpHeaders;
  /** 応答ボディ(生のバイト列) */
  body: Buffer;
  /** 応答ボディを UTF-8 として読んだ文字列 */
  text: string;
}

/**
 * 生の HTTP リクエストを送る
 *
 * パス(クエリを含む)は加工せずにそのまま送る。エンコード違いの回避パターンを
 * 試すため、呼び出し側が自分でエンコードする。
 *
 * @param target 接続先(ポート番号を持つオブジェクト)
 * @param path リクエストのパスとクエリ(例: `/api/file?path=src%2Fa.ts`)
 * @param options メソッド、ヘッダ、ボディなど
 * @returns ステータス、ヘッダ、ボディ
 */
export function request(
  target: HttpTarget,
  path: string,
  options: RequestOptions = {}
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const hasHost = Object.keys(headers).some((k) => k.toLowerCase() === 'host');
  if (!hasHost) {
    headers.Host = `127.0.0.1:${target.port}`;
  }
  if (options.body !== undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(options.body));
  }

  return new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      {
        host: options.address ?? '127.0.0.1',
        port: target.port,
        path,
        method: options.method ?? 'GET',
        headers,
        // Host ヘッダを Node.js に自動設定させず、指定した値をそのまま送る
        setHost: false,
        // テスト間で接続を使い回さない(サーバー終了の検証を安定させる)
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text: body.toString('utf8'),
          });
        });
      }
    );
    req.setTimeout(options.timeoutMs ?? 10_000, () => {
      req.destroy(new Error(`応答が時間内に返りませんでした: ${options.method ?? 'GET'} ${path}`));
    });
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * TCP 接続を試みた結果
 * - `connected`: 接続できた
 * - `refused`: 接続を拒否された(ECONNREFUSED。そのアドレスとポートでは誰も待ち受けていない)
 * - `timeout`: 時間内に応答が無かった(ファイアウォールなどで、拒否かどうかを判別できない)
 * - `error`: そのほかのエラー(到達できないアドレスなど)
 */
export type ConnectOutcome = 'connected' | 'refused' | 'timeout' | 'error';

/**
 * 指定したアドレスとポートへ TCP 接続を試み、結果を区別して返す
 *
 * @param address 接続先のアドレス
 * @param port 接続先のポート番号
 * @param timeoutMs 接続を待つ上限(ミリ秒)
 * @returns 結果の種類と、エラーのときはそのコード(例: `ECONNREFUSED`)
 */
export function probeConnect(
  address: string,
  port: number,
  timeoutMs = 1_000
): Promise<{ outcome: ConnectOutcome; code?: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port });
    /**
     * ソケットを閉じて、結果を確定する
     * @param outcome 結果の種類
     * @param code エラーコード(エラーのときだけ)
     * @returns なし
     */
    const finish = (outcome: ConnectOutcome, code?: string): void => {
      socket.destroy();
      resolve(code === undefined ? { outcome } : { outcome, code });
    };
    socket.setTimeout(timeoutMs, () => finish('timeout'));
    socket.once('connect', () => finish('connected'));
    // 接続のエラーは、握りつぶさずに「結果」として種類とコードを呼び出し側へ返す
    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ECONNREFUSED' ? 'refused' : 'error', err.code);
    });
  });
}

/**
 * 指定したアドレスとポートへ TCP 接続できるかを調べる
 *
 * @param address 接続先のアドレス
 * @param port 接続先のポート番号
 * @param timeoutMs 接続を待つ上限(ミリ秒)
 * @returns 接続できたら true。拒否された、エラーになった、または時間内に接続できなければ false
 */
export async function canConnect(address: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  const result = await probeConnect(address, port, timeoutMs);
  return result.outcome === 'connected';
}

/**
 * 条件が満たされるまでポーリングで待つ(固定時間の sleep の代わり)
 *
 * @param condition 満たされたら true を返す関数
 * @param timeoutMs 待つ上限(ミリ秒)
 * @param intervalMs 確認の間隔(ミリ秒)
 * @returns 時間内に条件が満たされたら true、満たされなければ false
 */
export async function waitUntil(
  condition: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

/**
 * JSON の値に含まれる文字列(オブジェクトのキーと値の両方)を、再帰的にすべて集める
 *
 * SPEC は応答の JSON の形(フィールド名)を定めていないので、
 * 形に依存せずに「この文字列が含まれるか」を調べるために使う。
 *
 * @param value JSON として解釈した値
 * @returns 含まれていた文字列の配列
 */
export function collectStrings(value: unknown): string[] {
  const out: string[] = [];
  /**
   * 値を再帰的にたどり、見つけた文字列を out に追加する
   * @param v たどる値
   * @returns なし
   */
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      out.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v !== null && typeof v === 'object') {
      for (const [key, item] of Object.entries(v)) {
        out.push(key);
        walk(item);
      }
    }
  };
  walk(value);
  return out;
}

/**
 * 応答ボディを JSON として解釈する
 *
 * @param text 応答ボディ
 * @returns 解釈できたら `{ ok: true, value }`、できなければ `{ ok: false }`
 */
export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    // JSON でない応答は「JSON ではない」という結果として呼び出し側に返す。
    // 構文エラー以外の例外は想定外なので、握りつぶさずに投げ直す
    if (err instanceof SyntaxError) return { ok: false };
    throw err;
  }
}

/**
 * 一覧系の応答に、指定した名前のファイル・ディレクトリが載っているかを調べる
 *
 * JSON なら、含まれる文字列のどれかが「名前そのもの」か「…/名前」で終わる
 * パス(末尾の `/` は無視)であれば、載っているとみなす。
 * JSON でなければ、ボディの文字列に名前が含まれるかで判定する。
 *
 * @param text 応答ボディ
 * @param name ファイル名またはリポジトリ相対パス(例: `.env`、`subdir/.env`)
 * @returns 載っていれば true
 */
export function listsName(text: string, name: string): boolean {
  const parsed = tryParseJson(text);
  if (!parsed.ok) return text.includes(name);
  return collectStrings(parsed.value).some((raw) => {
    const s = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    return s === name || s.endsWith(`/${name}`);
  });
}

/**
 * 応答ボディに、指定したテキストが(JSON 文字列の中身としても)含まれるかを調べる
 *
 * JSON の文字列値の中では `"` や改行がエスケープされるので、
 * 生のボディと、JSON として解釈した後の文字列の両方を調べる。
 *
 * @param text 応答ボディ
 * @param needle 探すテキスト
 * @returns 含まれていれば true
 */
export function bodyContains(text: string, needle: string): boolean {
  if (text.includes(needle)) return true;
  const parsed = tryParseJson(text);
  if (!parsed.ok) return false;
  return collectStrings(parsed.value).some((s) => s.includes(needle));
}
