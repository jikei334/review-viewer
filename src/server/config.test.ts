/**
 * T1-1: 設定の読み込みの単体テスト(SPEC §2.5、C-3、C-5)
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseAllowList, parsePort } from './config.js';

describe('T1-1: loadConfig の既定値(SPEC §2.5)', () => {
  it('T1-1: 環境変数が何も無ければ、SPEC §2.5 の既定値になる', () => {
    expect(loadConfig({})).toEqual({
      repoDir: '/repo',
      dataDir: '/data',
      host: '127.0.0.1',
      port: 3000,
      allowedHosts: ['127.0.0.1:3000', 'localhost:3000'],
      allowedOrigins: ['http://127.0.0.1:3000', 'http://localhost:3000'],
    });
  });

  it('C-3: HOST が未設定なら 127.0.0.1 に bind する(0.0.0.0 を既定にしない)', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(loadConfig({ PORT: '8080' }).host).toBe('127.0.0.1');
  });

  it('C-3: HOST が空文字や空白だけでも、127.0.0.1 に bind する', () => {
    expect(loadConfig({ HOST: '' }).host).toBe('127.0.0.1');
    expect(loadConfig({ HOST: '   ' }).host).toBe('127.0.0.1');
  });

  it('T1-1: 許可リストの既定値は、指定した PORT に追従する', () => {
    const config = loadConfig({ PORT: '45678' });
    expect(config.port).toBe(45678);
    expect(config.allowedHosts).toEqual(['127.0.0.1:45678', 'localhost:45678']);
    expect(config.allowedOrigins).toEqual(['http://127.0.0.1:45678', 'http://localhost:45678']);
  });

  it('C-3: HOST を変えても、許可リストの既定値は 127.0.0.1 と localhost のまま', () => {
    const config = loadConfig({ HOST: '0.0.0.0', PORT: '4000' });
    expect(config.host).toBe('0.0.0.0');
    expect(config.allowedHosts).toEqual(['127.0.0.1:4000', 'localhost:4000']);
    expect(config.allowedOrigins).toEqual(['http://127.0.0.1:4000', 'http://localhost:4000']);
  });
});

describe('T1-1: loadConfig の指定値', () => {
  it('T1-1: 指定した値がそのまま使われる', () => {
    const config = loadConfig({
      REPO_DIR: '/srv/repo',
      DATA_DIR: '/srv/data',
      HOST: '192.168.1.10',
      PORT: '8080',
      ALLOWED_HOSTS: 'review.test:8080',
      ALLOWED_ORIGINS: 'http://review.test:8080',
    });
    expect(config).toEqual({
      repoDir: '/srv/repo',
      dataDir: '/srv/data',
      host: '192.168.1.10',
      port: 8080,
      allowedHosts: ['review.test:8080'],
      allowedOrigins: ['http://review.test:8080'],
    });
  });

  it('C-1: ALLOWED_HOSTS を指定すると、既定の値は含まれない', () => {
    const config = loadConfig({ PORT: '3000', ALLOWED_HOSTS: 'review.test:3000' });
    expect(config.allowedHosts).toEqual(['review.test:3000']);
  });

  it('C-2: ALLOWED_ORIGINS を指定すると、既定の値は含まれない', () => {
    const config = loadConfig({ PORT: '3000', ALLOWED_ORIGINS: 'http://review.test:3000' });
    expect(config.allowedOrigins).toEqual(['http://review.test:3000']);
  });

  it('T1-1: 空文字の ALLOWED_HOSTS / ALLOWED_ORIGINS は、未設定として既定値になる', () => {
    const config = loadConfig({ ALLOWED_HOSTS: '', ALLOWED_ORIGINS: '  ' });
    expect(config.allowedHosts).toEqual(['127.0.0.1:3000', 'localhost:3000']);
    expect(config.allowedOrigins).toEqual(['http://127.0.0.1:3000', 'http://localhost:3000']);
  });

  it.each([
    ['ALLOWED_HOSTS', ','],
    ['ALLOWED_HOSTS', ' , , '],
    ['ALLOWED_ORIGINS', ','],
  ])('T1-1: %s が区切りだけ("%s")なら、設定の誤りとして止める', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(ConfigError);
  });

  it('C-5: REVIEW_VIEWER_TOKEN は設定に載せない', () => {
    const token = 'unit-test-dummy-token-not-real';
    const config = loadConfig({ REVIEW_VIEWER_TOKEN: token });
    expect(JSON.stringify(config)).not.toContain(token);
  });
});

describe('T1-1: parsePort', () => {
  it('T1-1: 未設定なら 3000', () => {
    expect(parsePort(undefined)).toBe(3000);
  });

  it.each([
    ['1', 1],
    ['3000', 3000],
    ['65535', 65535],
  ])('T1-1: "%s" は %d になる', (value, expected) => {
    expect(parsePort(value)).toBe(expected);
  });

  it.each(['0', '65536', '99999', '100000', '-1', '+80', '80.5', '1e3', '0x50', 'abc', '80 80', '80a'])(
    'T1-1: 不正な PORT("%s")は ConfigError になる',
    (value) => {
      expect(() => parsePort(value)).toThrow(ConfigError);
    }
  );

  it('T1-1: loadConfig は、不正な PORT で起動しない', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
  });
});

describe('T1-1: parseAllowList', () => {
  it('T1-1: カンマで区切り、前後の空白を除く', () => {
    expect(parseAllowList(' a.test:1 , b.test:2 ')).toEqual(['a.test:1', 'b.test:2']);
  });

  it('T1-1: 空の要素を捨てる', () => {
    expect(parseAllowList('a.test:1,,b.test:2,')).toEqual(['a.test:1', 'b.test:2']);
  });

  it('T1-1: 小文字に揃え、重複を除く', () => {
    expect(parseAllowList('Review.Test:1,review.test:1')).toEqual(['review.test:1']);
  });

  it('T1-1: 要素が無ければ空の配列', () => {
    expect(parseAllowList(' , ')).toEqual([]);
  });
});
