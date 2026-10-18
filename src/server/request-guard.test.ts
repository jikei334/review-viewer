/**
 * T1-1: リクエストの検証の単体テスト(C-1: Host、C-2: Origin / Content-Type)
 */
import { describe, expect, it } from 'vitest';
import {
  checkRequest,
  isHostAllowed,
  isJsonContentType,
  isOriginAllowed,
  isStateChangingMethod,
  type GuardedRequest,
} from './request-guard.js';

const ALLOWED_HOSTS = ['127.0.0.1:3000', 'localhost:3000'];
const ALLOWED_ORIGINS = ['http://127.0.0.1:3000', 'http://localhost:3000'];
const POLICY = { allowedHosts: ALLOWED_HOSTS, allowedOrigins: ALLOWED_ORIGINS };

/**
 * 検証に通る GET リクエストを土台に、指定した項目だけを差し替える
 *
 * @param overrides 差し替える項目
 * @returns 検証に渡すリクエスト
 */
function makeRequest(overrides: Partial<GuardedRequest>): GuardedRequest {
  return {
    method: 'GET',
    host: '127.0.0.1:3000',
    origin: undefined,
    contentType: undefined,
    ...overrides,
  };
}

describe('C-1: isHostAllowed', () => {
  it.each(['127.0.0.1:3000', 'localhost:3000'])('C-1: 許可リスト内の Host(%s)は通す', (host) => {
    expect(isHostAllowed(host, ALLOWED_HOSTS)).toBe(true);
  });

  it.each([
    'evil.com',
    'evil.com:3000',
    // ポートなし・ポート違い
    '127.0.0.1',
    'localhost',
    '127.0.0.1:1',
    '127.0.0.1:30000',
    '127.0.0.1:300',
    // 前方一致・後方一致・部分一致
    '127.0.0.1:3000.evil.com',
    'localhost:3000.evil.com',
    '127.0.0.1.evil.com:3000',
    'localhost.evil.com:3000',
    'evil-localhost:3000',
    'evil.com/127.0.0.1:3000',
    '127.0.0.1:3000@evil.com',
    'evil.com@127.0.0.1:3000',
    // 別の表記のループバック
    '0.0.0.0:3000',
    '[::1]:3000',
    '127.1:3000',
    '2130706433:3000',
    // 末尾のドット、空白、複数の値
    'localhost.:3000',
    ' localhost:3000',
    'localhost:3000 ',
    'localhost:3000, evil.com',
    '127.0.0.1:3000,localhost:3000',
    // スキームつき
    'http://127.0.0.1:3000',
  ])('C-1: 許可リスト外の Host(%s)は通さない', (host) => {
    expect(isHostAllowed(host, ALLOWED_HOSTS)).toBe(false);
  });

  it('C-1: Host が無い(undefined)なら通さない', () => {
    expect(isHostAllowed(undefined, ALLOWED_HOSTS)).toBe(false);
  });

  it('C-1: Host が空文字なら通さない(許可リストに空文字が紛れていても)', () => {
    expect(isHostAllowed('', ALLOWED_HOSTS)).toBe(false);
    expect(isHostAllowed('', [''])).toBe(false);
  });

  it('C-1: 許可リストが空なら、何も通さない', () => {
    expect(isHostAllowed('127.0.0.1:3000', [])).toBe(false);
  });

  it('C-1: 許可リストの `*` は、ワイルドカードとして働かない', () => {
    expect(isHostAllowed('evil.com', ['*'])).toBe(false);
    expect(isHostAllowed('a.review.test:3000', ['*.review.test:3000'])).toBe(false);
  });

  it('C-1: ホスト名の大文字小文字は区別しない', () => {
    expect(isHostAllowed('LOCALHOST:3000', ALLOWED_HOSTS)).toBe(true);
    expect(isHostAllowed('LocalHost:3000', ALLOWED_HOSTS)).toBe(true);
  });

  it('C-1: 指定した許可リストだけが通る', () => {
    expect(isHostAllowed('review.test:3000', ['review.test:3000'])).toBe(true);
    expect(isHostAllowed('127.0.0.1:3000', ['review.test:3000'])).toBe(false);
  });
});

describe('C-2: isOriginAllowed', () => {
  it.each(['http://127.0.0.1:3000', 'http://localhost:3000'])(
    'C-2: 許可リスト内の Origin(%s)は通す',
    (origin) => {
      expect(isOriginAllowed(origin, ALLOWED_ORIGINS)).toBe(true);
    }
  );

  it.each([
    'http://evil.com',
    'http://evil.com:3000',
    'null',
    // スキーム違い・ポート違い・ポートなし
    'https://127.0.0.1:3000',
    'ws://127.0.0.1:3000',
    'http://127.0.0.1:1',
    'http://127.0.0.1:30000',
    'http://127.0.0.1',
    'http://localhost',
    // スキームなし
    '127.0.0.1:3000',
    '//127.0.0.1:3000',
    // 前方一致・後方一致・部分一致
    'http://127.0.0.1:3000.evil.com',
    'http://localhost:3000.evil.com',
    'http://localhost.evil.com:3000',
    'http://evil.com/http://127.0.0.1:3000',
    'http://evil-localhost:3000',
    'http://127.0.0.1:3000@evil.com',
    'http://evil.com@127.0.0.1:3000',
    // 末尾のスラッシュやパス、複数の値
    'http://127.0.0.1:3000/',
    'http://127.0.0.1:3000/path',
    'http://127.0.0.1:3000 http://evil.com',
    'http://127.0.0.1:3000, http://evil.com',
    // 別の表記のループバック
    'http://[::1]:3000',
    'http://0.0.0.0:3000',
  ])('C-2: 許可リスト外の Origin(%s)は通さない', (origin) => {
    expect(isOriginAllowed(origin, ALLOWED_ORIGINS)).toBe(false);
  });

  it('C-2: Origin が無い、または空文字なら、許可リスト内とは判定しない', () => {
    expect(isOriginAllowed(undefined, ALLOWED_ORIGINS)).toBe(false);
    expect(isOriginAllowed('', ALLOWED_ORIGINS)).toBe(false);
  });

  it('C-2: 許可リストの `*` や `null` 以外で、`null` が通ることはない', () => {
    expect(isOriginAllowed('null', ['*'])).toBe(false);
  });
});

describe('C-2: isStateChangingMethod', () => {
  it.each(['POST', 'PATCH', 'DELETE', 'PUT', 'post', 'Delete', 'PROPFIND', 'FOO'])(
    'C-2: %s は、状態を変更するメソッドとして扱う',
    (method) => {
      expect(isStateChangingMethod(method)).toBe(true);
    }
  );

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('C-2: %s は、状態を変更しないメソッド', (method) => {
    expect(isStateChangingMethod(method)).toBe(false);
  });
});

describe('C-2: isJsonContentType', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'application/json;charset=UTF-8',
    'Application/JSON',
    ' application/json ',
  ])('C-2: %s は JSON', (contentType) => {
    expect(isJsonContentType(contentType)).toBe(true);
  });

  it.each([
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'text/plain; application/json',
    'text/plain; charset=application/json',
    'application/jsonx',
    'application/json-seq',
    'xapplication/json',
    'application/ld+json',
    'text/json',
    'application/json, text/plain',
    'json',
    '',
  ])('C-2: %s は JSON ではない', (contentType) => {
    expect(isJsonContentType(contentType)).toBe(false);
  });

  it('C-2: Content-Type が無ければ JSON ではない', () => {
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe('C-1 / C-2: checkRequest', () => {
  it('C-1: GET で Host が許可リスト内なら通す', () => {
    expect(checkRequest(makeRequest({}), POLICY)).toEqual({ ok: true });
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'POST', 'PATCH', 'DELETE'])(
    'C-1: %s で Host が許可リスト外なら拒否する(Origin と Content-Type が正しくても)',
    (method) => {
      const result = checkRequest(
        makeRequest({
          method,
          host: 'evil.com',
          origin: 'http://127.0.0.1:3000',
          contentType: 'application/json',
        }),
        POLICY
      );
      expect(result).toEqual({ ok: false, reason: 'host_not_allowed' });
    }
  );

  it('C-1: Host が無ければ拒否する', () => {
    expect(checkRequest(makeRequest({ host: undefined }), POLICY)).toEqual({
      ok: false,
      reason: 'host_not_allowed',
    });
  });

  it('C-2: GET は、Origin が無くても通す', () => {
    expect(checkRequest(makeRequest({ method: 'GET' }), POLICY)).toEqual({ ok: true });
  });

  it('C-2: GET は、Origin が許可リスト外でも通す(状態を変更しないため)', () => {
    expect(checkRequest(makeRequest({ method: 'GET', origin: 'http://evil.com' }), POLICY)).toEqual({
      ok: true,
    });
  });

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])(
    'C-2: %s で Origin が許可リスト内なら通す',
    (method) => {
      const result = checkRequest(
        makeRequest({ method, origin: 'http://localhost:3000', contentType: 'application/json' }),
        POLICY
      );
      expect(result).toEqual({ ok: true });
    }
  );

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])(
    'C-2: %s で Origin が許可リスト外なら、Content-Type が JSON でも拒否する',
    (method) => {
      const result = checkRequest(
        makeRequest({ method, origin: 'http://evil.com', contentType: 'application/json' }),
        POLICY
      );
      expect(result).toEqual({ ok: false, reason: 'origin_not_allowed' });
    }
  );

  it('C-2: POST で Origin が null なら拒否する', () => {
    const result = checkRequest(
      makeRequest({ method: 'POST', origin: 'null', contentType: 'application/json' }),
      POLICY
    );
    expect(result).toEqual({ ok: false, reason: 'origin_not_allowed' });
  });

  it('C-2: POST で Origin が空文字なら、「無い」ではなく許可リスト外として拒否する', () => {
    const result = checkRequest(
      makeRequest({ method: 'POST', origin: '', contentType: 'application/json' }),
      POLICY
    );
    expect(result).toEqual({ ok: false, reason: 'origin_not_allowed' });
  });

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])(
    'C-2: %s で Origin が無く、Content-Type が JSON なら通す',
    (method) => {
      const result = checkRequest(makeRequest({ method, contentType: 'application/json' }), POLICY);
      expect(result).toEqual({ ok: true });
    }
  );

  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])(
    'C-2: %s で Origin が無く、Content-Type が JSON でないなら拒否する',
    (method) => {
      const result = checkRequest(makeRequest({ method, contentType: 'text/plain' }), POLICY);
      expect(result).toEqual({ ok: false, reason: 'content_type_not_json' });
    }
  );

  it('C-2: POST で Origin も Content-Type も無ければ拒否する', () => {
    expect(checkRequest(makeRequest({ method: 'POST' }), POLICY)).toEqual({
      ok: false,
      reason: 'content_type_not_json',
    });
  });

  it('C-2: POST で Origin が許可リスト内なら、Content-Type が JSON でなくても CSRF としては拒否しない', () => {
    // SPEC C-2 の拒否条件は「Origin が許可リスト外」または「Origin が無く JSON でない」の2つだけ
    const result = checkRequest(
      makeRequest({ method: 'POST', origin: 'http://127.0.0.1:3000', contentType: 'text/plain' }),
      POLICY
    );
    expect(result).toEqual({ ok: true });
  });
});
