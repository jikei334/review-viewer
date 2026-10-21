/**
 * T2-3: コメントの path の形式の検証の単体テスト(SPEC §2.2、S2-4)
 */
import { describe, expect, it } from 'vitest';
import { parseCommentPath, parsePathFilter } from './comment-path.js';
import { RepoAccessError } from './path-policy.js';

describe('S2-4: parseCommentPath(正規の形だけを受け付ける)', () => {
  it.each(['a.ts', 'src/example.ts', 'a/b/c.txt', '.github/workflows/ci.yml', 'dir/%2e%2e%2fx', 'a b/c d.md'])(
    'S2-4: 正規の形(%s)はそのまま返す',
    (path) => {
      expect(parseCommentPath(path)).toBe(path);
    }
  );

  const bad: Array<[label: string, path: string]> = [
    ['空文字列', ''],
    ['.. だけ', '..'],
    ['先頭の ../', '../x'],
    ['途中の ..', 'a/../b'],
    ['リポジトリ内に収まる ..', 'src/../src/example.ts'],
    ['絶対パス', '/etc/passwd'],
    ['先頭の //', '//src/example.ts'],
    ['NUL', 'a\u0000b'],
    ['制御文字(改行)', 'a\nb'],
    ['バックスラッシュ', 'a\\b'],
    ['バックスラッシュで ..', '..\\x'],
    ['先頭の ./', './a'],
    ['空の要素', 'a//b'],
    ['. の要素', 'a/./b'],
    ['末尾の /', 'a/'],
    ['. だけ', '.'],
    ['./ だけ', './'],
    ['/ だけ', '/'],
    ['長すぎる', `${'a'.repeat(300)}`],
    ['全体が長すぎる', `${'a/'.repeat(3000)}a`],
  ];
  it.each(bad)('S2-4: %s は invalid_path(400)', (_label, path) => {
    expect(() => parseCommentPath(path)).toThrow(RepoAccessError);
    try {
      parseCommentPath(path);
    } catch (err: unknown) {
      expect((err as RepoAccessError).code).toBe('invalid_path');
    }
  });

  it('C-5: エラーのメッセージに、受け取ったパスを含めない', () => {
    try {
      parseCommentPath('../SECRET_PATH_SENTINEL');
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as Error).message).not.toContain('SECRET_PATH_SENTINEL');
    }
  });
});

describe('S2-4: parsePathFilter(一覧の絞り込み)', () => {
  it('S2-4: 省略と空文字列は「指定なし」', () => {
    expect(parsePathFilter(undefined)).toBeUndefined();
    expect(parsePathFilter('')).toBeUndefined();
  });

  it('S2-4: 正規の形はそのまま返す', () => {
    expect(parsePathFilter('src/a.ts')).toBe('src/a.ts');
  });

  it.each(['../x', '/abs', 'a\u0000', 'a/', './a', 'a//b', 'a\\b'])('S2-4: %j は invalid_path', (path) => {
    expect(() => parsePathFilter(path)).toThrow(RepoAccessError);
  });
});
