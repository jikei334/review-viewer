/**
 * 開発サーバー(dev.ts)の経路の判定。副作用がないので、単体テストできる
 */

/**
 * リクエストの URL が、API 側で処理するものかを判定する
 *
 * @param url リクエストの URL(パスとクエリ)
 * @returns `/healthz` または `/api` 配下なら true
 */
export function isApiPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  const path = url.split('?', 1)[0] ?? '';
  return path === '/healthz' || path === '/api' || path.startsWith('/api/');
}
