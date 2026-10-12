/**
 * T1-2: `.gitignore` の判定の単体テスト(S1-5)
 *
 * パターンの解釈は `ignore` パッケージに任せている。ここでは、複数の `.gitignore` の
 * 組み合わせ方(優先順位、親ディレクトリの除外、ディレクトリ専用のパターン)を確かめる。
 * ファイルシステムは使わず、`.gitignore` の中身をメモリから渡す。
 */
import { describe, expect, it, vi } from 'vitest';
import { GitignoreMatcher } from './gitignore.js';

/**
 * メモリ上の `.gitignore` を使う判定器を作る
 *
 * @param files ディレクトリ(`/` 区切り。ルートは空文字列)から、`.gitignore` の中身への対応
 * @returns 判定器
 */
function matcherFor(files: Record<string, string>): GitignoreMatcher {
  return new GitignoreMatcher((dirSegments) => Promise.resolve(files[dirSegments.join('/')] ?? null));
}

describe('S1-5: GitignoreMatcher(ルートの .gitignore)', () => {
  const rules = ['# コメント', 'excluded-by-git.txt', '*.log', 'build-out/', 'reports/2026-12-31-ignored.md', '/only-root.txt', ''].join('\n');

  it.each<[string, boolean, boolean]>([
    ['excluded-by-git.txt', false, true],
    ['debug.log', false, true],
    ['subdir/trace.log', false, true],
    ['subdir/excluded-by-git.txt', false, true],
    ['build-out', true, true],
    ['build-out/artifact.txt', false, true],
    ['build-out/deep/artifact.txt', false, true],
    ['sub/build-out/artifact.txt', false, true],
    ['reports/2026-12-31-ignored.md', false, true],
    ['only-root.txt', false, true],
    // 除外されないもの
    ['src/example.ts', false, false],
    ['reports/2026-10-12-feature.md', false, false],
    ['reports', true, false],
    ['sub/only-root.txt', false, false],
    ['debug.log.txt', false, false],
    // `build-out/` はディレクトリだけに当たる。同じ名前のファイルには当たらない
    ['build-out', false, false],
    // 大文字小文字を区別する(Linux 上の git と同じ)
    ['DEBUG.LOG', false, false],
  ])('S1-5: %j(ディレクトリ: %j)→ 除外: %j', async (path, isDirectory, expected) => {
    expect(await matcherFor({ '': rules }).isIgnored(path.split('/'), isDirectory)).toBe(expected);
  });

  it('S1-5: ルートそのものは除外されない', async () => {
    expect(await matcherFor({ '': '*' }).isIgnored([], true)).toBe(false);
  });

  it('S1-5: .gitignore が無ければ、何も除外されない', async () => {
    expect(await matcherFor({}).isIgnored(['debug.log'], false)).toBe(false);
  });

  it('S1-5: CRLF の .gitignore も読める', async () => {
    const matcher = matcherFor({ '': '*.log\r\nbuild-out/\r\n' });
    expect(await matcher.isIgnored(['debug.log'], false)).toBe(true);
    expect(await matcher.isIgnored(['build-out', 'a.txt'], false)).toBe(true);
  });
});

describe('S1-5: GitignoreMatcher(否定パターンと、サブディレクトリの .gitignore)', () => {
  it('S1-5: 同じ .gitignore の否定パターンで、除外を戻せる', async () => {
    const matcher = matcherFor({ '': '*.log\n!keep.log\n' });
    expect(await matcher.isIgnored(['debug.log'], false)).toBe(true);
    expect(await matcher.isIgnored(['keep.log'], false)).toBe(false);
    expect(await matcher.isIgnored(['sub', 'keep.log'], false)).toBe(false);
  });

  it('S1-5: サブディレクトリの .gitignore は、そのディレクトリの配下にだけ効く', async () => {
    const matcher = matcherFor({ sub: '*.tmp\n/local-only.txt\n' });
    expect(await matcher.isIgnored(['sub', 'a.tmp'], false)).toBe(true);
    expect(await matcher.isIgnored(['sub', 'deep', 'a.tmp'], false)).toBe(true);
    expect(await matcher.isIgnored(['sub', 'local-only.txt'], false)).toBe(true);
    expect(await matcher.isIgnored(['sub', 'deep', 'local-only.txt'], false)).toBe(false);
    expect(await matcher.isIgnored(['a.tmp'], false)).toBe(false);
    expect(await matcher.isIgnored(['other', 'a.tmp'], false)).toBe(false);
  });

  it('S1-5: 深い .gitignore の否定パターンが、浅い .gitignore の除外より優先される', async () => {
    const matcher = matcherFor({ '': '*.log\n', sub: '!important.log\n' });
    expect(await matcher.isIgnored(['sub', 'important.log'], false)).toBe(false);
    expect(await matcher.isIgnored(['sub', 'other.log'], false)).toBe(true);
    expect(await matcher.isIgnored(['important.log'], false)).toBe(true);
  });

  it('S1-5: 深い .gitignore の除外が、浅い .gitignore の否定パターンより優先される', async () => {
    const matcher = matcherFor({ '': '!*.txt\n', sub: '*.txt\n' });
    expect(await matcher.isIgnored(['sub', 'a.txt'], false)).toBe(true);
    expect(await matcher.isIgnored(['a.txt'], false)).toBe(false);
  });

  it('S1-5: 親ディレクトリが除外されていたら、配下は否定パターンでも戻せない(git と同じ)', async () => {
    const matcher = matcherFor({
      '': 'build-out/\n!build-out/keep.txt\n',
      'build-out': '!keep.txt\n!*\n',
    });
    expect(await matcher.isIgnored(['build-out', 'keep.txt'], false)).toBe(true);
    expect(await matcher.isIgnored(['build-out'], true)).toBe(true);
  });
});

describe('S1-5: GitignoreMatcher(読み込み)', () => {
  it('S1-5: 同じディレクトリの .gitignore は、1回の操作で1回だけ読む', async () => {
    const load = vi.fn((dirSegments: readonly string[]) =>
      Promise.resolve(dirSegments.length === 0 ? '*.log\n' : null)
    );
    const matcher = new GitignoreMatcher(load);
    await Promise.all([
      matcher.isIgnored(['a', 'x.ts'], false),
      matcher.isIgnored(['a', 'y.ts'], false),
      matcher.isIgnored(['z.ts'], false),
    ]);
    const loadedDirs = load.mock.calls.map(([dirSegments]) => dirSegments.join('/'));
    expect(loadedDirs.sort()).toEqual(['', 'a']);
  });

  it('S1-5: .gitignore を読めなかったら、除外なしとして通さず、エラーを伝える', async () => {
    const matcher = new GitignoreMatcher(() => Promise.reject(new Error('read failed')));
    await expect(matcher.isIgnored(['a.txt'], false)).rejects.toThrow('read failed');
  });
});
