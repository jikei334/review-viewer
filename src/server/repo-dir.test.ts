/**
 * T1-8: 対象リポジトリの決め方の単体テスト(SPEC §2.5、S1-10、C-5)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RepoDirCancelledError,
  RepoDirError,
  resolveBaseDir,
  resolveRepoDir,
  type PathKind,
  type RepoDirDeps,
} from './repo-dir.js';

/**
 * テスト用の依存を作る
 *
 * @param kinds 絶対パスごとの種類(載っていないパスは not_found)
 * @param over 上書きする項目
 * @returns 依存
 */
function makeDeps(kinds: Record<string, PathKind>, over: Partial<RepoDirDeps> = {}): RepoDirDeps {
  return {
    args: [],
    env: {},
    baseDir: '/work',
    inspect: (path) => kinds[path] ?? 'not_found',
    isInteractive: false,
    prompt: () => Promise.reject(new Error('prompt は呼ばれない想定')),
    ...over,
  };
}

describe('S1-10: resolveBaseDir', () => {
  it('S1-10: INIT_CWD が絶対パスならそれを使う', () => {
    expect(resolveBaseDir({ INIT_CWD: '/home/u/proj' }, '/app')).toBe('/home/u/proj');
  });
  it.each([undefined, '', '  ', 'relative/dir'])('S1-10: INIT_CWD が %j なら cwd を使う', (v) => {
    expect(resolveBaseDir({ INIT_CWD: v }, '/app')).toBe('/app');
  });
});

describe('S1-10: 引数 → REPO_DIR → /repo の順', () => {
  it('S1-10: 引数が最優先(REPO_DIR や /repo があっても使わない)', async () => {
    const deps = makeDeps(
      { '/a': 'directory', '/b': 'directory', '/repo': 'directory' },
      { args: ['/a'], env: { REPO_DIR: '/b' } }
    );
    expect(await resolveRepoDir(deps)).toBe('/a');
  });

  it('S1-10: 相対パスの引数は baseDir 基準で解決される', async () => {
    const deps = makeDeps({ '/work/myrepo': 'directory' }, { args: ['myrepo'] });
    expect(await resolveRepoDir(deps)).toBe('/work/myrepo');
  });

  it('S1-10: 引数が不正なら、REPO_DIR が正しくても失敗する(入力にも進まない)', async () => {
    const prompt = vi.fn();
    const deps = makeDeps(
      { '/b': 'directory' },
      { args: ['/nope'], env: { REPO_DIR: '/b' }, isInteractive: true, prompt }
    );
    await expect(resolveRepoDir(deps)).rejects.toBeInstanceOf(RepoDirError);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('S1-10: 引数がファイルなら理由に「ディレクトリではありません」を示して失敗する', async () => {
    const deps = makeDeps({ '/f': 'not_directory' }, { args: ['/f'] });
    await expect(resolveRepoDir(deps)).rejects.toThrow('ディレクトリではありません');
  });

  it('S1-10: 引数が空文字なら失敗する', async () => {
    await expect(resolveRepoDir(makeDeps({}, { args: ['  '] }))).rejects.toBeInstanceOf(
      RepoDirError
    );
  });

  it('S1-10: 引数が2つ以上なら失敗する', async () => {
    const deps = makeDeps({ '/a': 'directory', '/b': 'directory' }, { args: ['/a', '/b'] });
    await expect(resolveRepoDir(deps)).rejects.toThrow('引数が多すぎます');
  });

  it('S1-10: 引数が無ければ REPO_DIR を使う', async () => {
    const deps = makeDeps({ '/b': 'directory', '/repo': 'directory' }, { env: { REPO_DIR: '/b' } });
    expect(await resolveRepoDir(deps)).toBe('/b');
  });

  it('S1-10: 相対パスの REPO_DIR も baseDir 基準で解決される', async () => {
    const deps = makeDeps({ '/work/r': 'directory' }, { env: { REPO_DIR: 'r' } });
    expect(await resolveRepoDir(deps)).toBe('/work/r');
  });

  it('S1-10: REPO_DIR が不正なら、/repo があっても失敗する(入力にも進まない)', async () => {
    const prompt = vi.fn();
    const deps = makeDeps(
      { '/repo': 'directory' },
      { env: { REPO_DIR: '/nope' }, isInteractive: true, prompt }
    );
    await expect(resolveRepoDir(deps)).rejects.toThrow('REPO_DIR');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('S1-10: REPO_DIR が空白だけなら未設定として扱い、/repo を使う', async () => {
    const deps = makeDeps({ '/repo': 'directory' }, { env: { REPO_DIR: '  ' } });
    expect(await resolveRepoDir(deps)).toBe('/repo');
  });

  it('S1-10: 引数も REPO_DIR も無ければ、存在する /repo を使う', async () => {
    expect(await resolveRepoDir(makeDeps({ '/repo': 'directory' }))).toBe('/repo');
  });
});

describe('S1-10: 決まらないとき', () => {
  it('S1-10: 端末でなければ、入力を求めず理由を示して失敗する', async () => {
    const prompt = vi.fn();
    const deps = makeDeps({}, { isInteractive: false, prompt });
    const err = await resolveRepoDir(deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoDirError);
    expect((err as Error).message).toContain('REPO_DIR');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('S1-10: /repo がファイルでも、端末でなければ失敗する', async () => {
    const deps = makeDeps({ '/repo': 'not_directory' });
    await expect(resolveRepoDir(deps)).rejects.toBeInstanceOf(RepoDirError);
  });

  it('S1-10: 端末なら入力を求め、存在するディレクトリが入力されたらそれを使う', async () => {
    const prompt = vi.fn().mockResolvedValueOnce('/x');
    const deps = makeDeps({ '/x': 'directory' }, { isInteractive: true, prompt });
    expect(await resolveRepoDir(deps)).toBe('/x');
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('S1-10: 入力された相対パスは baseDir 基準、前後の空白は除く', async () => {
    const prompt = vi.fn().mockResolvedValueOnce('  sub  ');
    const deps = makeDeps({ '/work/sub': 'directory' }, { isInteractive: true, prompt });
    expect(await resolveRepoDir(deps)).toBe('/work/sub');
  });

  it('S1-10: 存在しない・ディレクトリでない・空の入力は、理由を示して聞き直す', async () => {
    const prompt = vi
      .fn<(q: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce('/nope')
      .mockResolvedValueOnce('/file')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('/ok');
    const deps = makeDeps(
      { '/file': 'not_directory', '/ok': 'directory' },
      { isInteractive: true, prompt }
    );
    expect(await resolveRepoDir(deps)).toBe('/ok');
    expect(prompt).toHaveBeenCalledTimes(4);
    expect(prompt.mock.calls[1]?.[0]).toContain('/nope は存在しません');
    expect(prompt.mock.calls[2]?.[0]).toContain('/file はディレクトリではありません');
    expect(prompt.mock.calls[3]?.[0]).toContain('空');
  });

  it('S1-10: 入力が閉じられたら(undefined)、中断として扱う', async () => {
    const deps = makeDeps({}, { isInteractive: true, prompt: () => Promise.resolve(undefined) });
    await expect(resolveRepoDir(deps)).rejects.toBeInstanceOf(RepoDirCancelledError);
  });
});

describe('C-5: 理由に秘密を含めない', () => {
  it('C-5: 理由には、環境変数の名前と指定されたパスだけが入り、他の環境変数の値は入らない', async () => {
    const deps = makeDeps(
      {},
      { env: { REPO_DIR: '/nope', REVIEW_VIEWER_TOKEN: 'SECRET_TOKEN_VALUE' } }
    );
    const err = (await resolveRepoDir(deps).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('SECRET_TOKEN_VALUE');
  });
});
