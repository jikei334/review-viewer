/**
 * T2-2: 保存先の決め方の単体テスト(SPEC §2.5、S2-9、C-5)
 *
 * ファイルシステムは、メモリ上の偽物に差し替えて、すべての分岐を確かめる。
 */
import { describe, expect, it } from 'vitest';
import {
  DataDirError,
  resolveDataDir,
  type DataDirDeps,
  type DataDirFs,
  type EntryInfo,
} from './data-dir.js';

const UID = 1000;
const REPO = '/work/repo';

/** 偽のファイルシステムの1件 */
interface FakeEntry extends EntryInfo {
  /** シンボリックリンクの指す先(type が symlink のとき) */
  readonly target?: string;
  /** 書き込めないなら false */
  readonly writable?: boolean;
}

/** 偽のファイルシステムと、その操作の記録 */
interface Fake {
  readonly fs: DataDirFs;
  /** 呼ばれた mkdir のパス */
  readonly made: string[];
  readonly entries: Map<string, FakeEntry>;
}

/**
 * ディレクトリの情報を作る
 *
 * @param over 上書きする項目
 * @returns ディレクトリの情報
 */
function dir(over: Partial<FakeEntry> = {}): FakeEntry {
  return { type: 'directory', uid: UID, mode: 0o40700, ...over };
}

/**
 * 偽のファイルシステムを作る
 *
 * @param initial パスごとの情報(親ディレクトリは自動では作らない)
 * @param mkdirError mkdir が投げるエラーコード(指定時は常に失敗する)
 * @returns 偽のファイルシステム
 */
function makeFake(initial: Record<string, FakeEntry>, mkdirError?: string): Fake {
  const entries = new Map<string, FakeEntry>(Object.entries(initial));
  const made: string[] = [];
  /**
   * シンボリックリンクをたどる
   * @param path パス
   * @returns たどった先のパスとその情報
   */
  const follow = (path: string): { path: string; entry: FakeEntry | undefined } => {
    let current = path;
    for (let i = 0; i < 10; i += 1) {
      const e = entries.get(current);
      if (e?.type !== 'symlink') return { path: current, entry: e };
      current = e.target ?? '';
    }
    throw Object.assign(new Error('loop'), { code: 'ELOOP' });
  };
  const fs: DataDirFs = {
    lstat: (path) => entries.get(path),
    stat: (path) => follow(path).entry,
    realpath: (path) => {
      const r = follow(path);
      if (r.entry === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return r.path;
    },
    mkdir: (path, mode) => {
      made.push(path);
      if (mkdirError !== undefined) throw Object.assign(new Error('mkdir failed'), { code: mkdirError });
      if (entries.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      entries.set(path, dir({ mode: 0o40000 | mode }));
    },
    isWritable: (path) => follow(path).entry?.writable !== false,
  };
  return { fs, made, entries };
}

/**
 * テスト用の依存を作る
 *
 * @param fake 偽のファイルシステム
 * @param over 上書きする項目
 * @returns 依存
 */
function makeDeps(fake: Fake, over: Partial<DataDirDeps> = {}): DataDirDeps {
  return {
    argDataDir: undefined,
    env: {},
    baseDir: '/work',
    repoDir: REPO,
    uid: UID,
    fs: fake.fs,
    ...over,
  };
}

/** 基本のファイルシステム: リポジトリ、/work、/tmp がある */
const BASE = (): Record<string, FakeEntry> => ({
  '/': dir(),
  '/work': dir(),
  [REPO]: dir(),
  [`${REPO}/sub`]: dir(),
  '/tmp': dir({ mode: 0o41777, uid: 0 }),
});

describe('S2-9: 順番(引数 → DATA_DIR → /data → 一時ディレクトリ)', () => {
  it('S2-9: --data-dir が最優先(DATA_DIR や /data があっても使わない)', () => {
    const fake = makeFake({ ...BASE(), '/work/arg': dir(), '/work/env': dir(), '/data': dir() });
    const r = resolveDataDir(makeDeps(fake, { argDataDir: 'arg', env: { DATA_DIR: 'env' } }));
    expect(r).toEqual({ dir: '/work/arg', temporary: false });
    expect(fake.made).toEqual([]);
  });

  it('S2-9: --data-dir が無ければ DATA_DIR を使う(相対パスは基準ディレクトリから)', () => {
    const fake = makeFake({ ...BASE(), '/work/env': dir(), '/data': dir() });
    expect(resolveDataDir(makeDeps(fake, { env: { DATA_DIR: 'env' } }))).toEqual({
      dir: '/work/env',
      temporary: false,
    });
  });

  it.each([undefined, '', '   '])('S2-9: DATA_DIR が %j なら未設定として扱い、/data へ進む', (v) => {
    const fake = makeFake({ ...BASE(), '/data': dir() });
    expect(resolveDataDir(makeDeps(fake, { env: { DATA_DIR: v } }))).toEqual({ dir: '/data', temporary: false });
  });

  it('S2-9: 指定が無く /data が存在すれば /data を使う(作らない)', () => {
    const fake = makeFake({ ...BASE(), '/data': dir() });
    expect(resolveDataDir(makeDeps(fake))).toEqual({ dir: '/data', temporary: false });
    expect(fake.made).toEqual([]);
  });

  it('S2-9: /data が存在するのに使えない(ファイル)なら、一時ディレクトリへ進まずエラー', () => {
    const fake = makeFake({ ...BASE(), '/data': { type: 'file', uid: UID, mode: 0o100644 } });
    expect(() => resolveDataDir(makeDeps(fake))).toThrow(DataDirError);
    expect(fake.made).toEqual([]);
  });

  it('S2-9: /data が書き込めないなら、一時ディレクトリへ進まずエラー', () => {
    const fake = makeFake({ ...BASE(), '/data': dir({ writable: false }) });
    expect(() => resolveDataDir(makeDeps(fake))).toThrow(/書き込めません/);
    expect(fake.made).toEqual([]);
  });

  it('S2-9: どれも無ければ、一時ディレクトリの下の review-viewer-<UID> を 0700 で作る', () => {
    const fake = makeFake(BASE());
    const r = resolveDataDir(makeDeps(fake));
    expect(r).toEqual({ dir: `/tmp/review-viewer-${UID}`, temporary: true });
    expect(fake.entries.get(`/tmp/review-viewer-${UID}`)?.mode).toBe(0o40700);
  });

  it('S2-9: TMPDIR を尊重する(無ければ /tmp)', () => {
    const fake = makeFake({ ...BASE(), '/work/mytmp': dir() });
    const r = resolveDataDir(makeDeps(fake, { env: { TMPDIR: '/work/mytmp' } }));
    expect(r.dir).toBe(`/work/mytmp/review-viewer-${UID}`);
    expect(fake.made).toEqual([`/work/mytmp/review-viewer-${UID}`]);
  });

  it('S2-9: TMPDIR が空白だけなら /tmp を使う', () => {
    const fake = makeFake(BASE());
    expect(resolveDataDir(makeDeps(fake, { env: { TMPDIR: '  ' } })).dir).toBe(`/tmp/review-viewer-${UID}`);
  });
});

describe('S2-9: 指定したパスの作成(親は作らない)', () => {
  it('S2-9: 存在しなければ、親が存在するとき、0700 で作って使う', () => {
    const fake = makeFake(BASE());
    expect(resolveDataDir(makeDeps(fake, { argDataDir: 'new-leaf' }))).toEqual({
      dir: '/work/new-leaf',
      temporary: false,
    });
    expect(fake.made).toEqual(['/work/new-leaf']);
    expect(fake.entries.get('/work/new-leaf')?.mode).toBe(0o40700);
  });

  it('S2-9: DATA_DIR も同じく、親があれば作る', () => {
    const fake = makeFake(BASE());
    expect(resolveDataDir(makeDeps(fake, { env: { DATA_DIR: '/work/n' } })).dir).toBe('/work/n');
    expect(fake.made).toEqual(['/work/n']);
  });

  it('S2-9: 親ディレクトリも無ければ、親を作らずにエラー', () => {
    const fake = makeFake(BASE());
    expect(() => resolveDataDir(makeDeps(fake, { argDataDir: 'no-parent/child' }))).toThrow(/親ディレクトリ/);
    expect(fake.made).toEqual([]);
  });

  it('S2-9: 親がファイルならエラー(作らない)', () => {
    const fake = makeFake({ ...BASE(), '/work/a-file': { type: 'file', uid: UID, mode: 0o100644 } });
    expect(() => resolveDataDir(makeDeps(fake, { argDataDir: 'a-file/child' }))).toThrow(DataDirError);
    expect(fake.made).toEqual([]);
  });

  it('S2-9: 作成の直前に別の誰かが作ったとき(EEXIST)は、既存のものとして確認に進む', () => {
    const fake = makeFake(BASE());
    // stat では無く見えるが、mkdir の時点で存在した、という競合を作る
    const real = fake.fs;
    let first = true;
    const racing: DataDirFs = {
      ...real,
      stat: (p) => {
        if (p === '/work/raced' && first) {
          first = false;
          return undefined;
        }
        return real.stat(p);
      },
      mkdir: (p, m) => {
        fake.entries.set(p, dir());
        real.mkdir(p, m);
      },
    };
    expect(resolveDataDir(makeDeps({ ...fake, fs: racing }, { argDataDir: 'raced' })).dir).toBe('/work/raced');
  });

  it('S2-9: 作れない(mkdir が EACCES)なら、理由つきでエラー。次の候補へ進まない', () => {
    const fake = makeFake({ ...BASE(), '/data': dir() }, 'EACCES');
    let message = '';
    try {
      resolveDataDir(makeDeps(fake, { argDataDir: 'x' }));
    } catch (err: unknown) {
      message = (err as Error).message;
    }
    expect(message).toContain('EACCES');
    expect(fake.made).toEqual(['/work/x']); // /data や一時ディレクトリを試していない
  });

  it('S2-9: リンク切れのシンボリックリンクは、リンク先を作らずにエラー', () => {
    const fake = makeFake({ ...BASE(), '/work/dangling': { type: 'symlink', uid: UID, mode: 0o120777, target: '/work/none' } });
    expect(() => resolveDataDir(makeDeps(fake, { argDataDir: 'dangling' }))).toThrow(/リンク切れ/);
    expect(fake.made).toEqual([]);
  });
});

describe('S2-9: 指定したパスが使えないとき、次の候補へ進まない', () => {
  it.each([
    ['--data-dir', { argDataDir: 'a-file' }],
    ['DATA_DIR', { env: { DATA_DIR: 'a-file' } }],
  ] as const)('S2-9: %s がファイルならエラー(DATA_DIR・/data・一時ディレクトリに進まない)', (_label, over) => {
    const fake = makeFake({
      ...BASE(),
      '/work/a-file': { type: 'file', uid: UID, mode: 0o100644 },
      '/work/env': dir(),
      '/data': dir(),
    });
    expect(() => resolveDataDir(makeDeps(fake, { ...over }))).toThrow(/ディレクトリではありません/);
    expect(fake.made).toEqual([]);
  });

  it('S2-9: 書き込めないディレクトリならエラー', () => {
    const fake = makeFake({ ...BASE(), '/work/ro': dir({ writable: false }), '/data': dir() });
    expect(() => resolveDataDir(makeDeps(fake, { argDataDir: 'ro', env: { DATA_DIR: 'env' } }))).toThrow(
      /書き込めません/
    );
  });

  it.each([
    ['リポジトリそのもの', REPO],
    ['リポジトリの中の既存ディレクトリ', `${REPO}/sub`],
  ])('S2-9: %s はエラー', (_label, path) => {
    const fake = makeFake({ ...BASE(), '/data': dir() });
    expect(() => resolveDataDir(makeDeps(fake, { argDataDir: path }))).toThrow(/対象リポジトリの中/);
    expect(fake.made).toEqual([]);
  });

  it('S2-9: リポジトリの中の、まだ無いディレクトリは、作らずにエラー', () => {
    const fake = makeFake(BASE());
    expect(() => resolveDataDir(makeDeps(fake, { argDataDir: `${REPO}/new-data` }))).toThrow(/対象リポジトリの中/);
    expect(fake.made).toEqual([]);
  });

  it('S2-9: リポジトリの中を指すシンボリックリンク(実体で比べる)はエラー', () => {
    const fake = makeFake({
      ...BASE(),
      '/work/link': { type: 'symlink', uid: UID, mode: 0o120777, target: `${REPO}/sub` },
    });
    expect(() => resolveDataDir(makeDeps(fake, { argDataDir: 'link' }))).toThrow(/対象リポジトリの中/);
  });

  it('S2-9: リポジトリの外のシンボリックリンクは使える(実体のパスを返す)', () => {
    const fake = makeFake({
      ...BASE(),
      '/other': dir(),
      '/work/link': { type: 'symlink', uid: UID, mode: 0o120777, target: '/other' },
    });
    expect(resolveDataDir(makeDeps(fake, { argDataDir: 'link' })).dir).toBe('/other');
  });

  it('S2-9: 名前が似ているだけのディレクトリ(/work/repo-evil)はリポジトリの中ではない', () => {
    const fake = makeFake({ ...BASE(), '/work/repo-evil': dir() });
    expect(resolveDataDir(makeDeps(fake, { argDataDir: '/work/repo-evil' })).dir).toBe('/work/repo-evil');
  });

  it('S2-9: リポジトリの中の一時ディレクトリ(TMPDIR がリポジトリの中)もエラー', () => {
    const fake = makeFake(BASE());
    expect(() => resolveDataDir(makeDeps(fake, { env: { TMPDIR: REPO } }))).toThrow(/対象リポジトリの中/);
  });
});

describe('S2-9: 一時ディレクトリの既存のものの検査', () => {
  const NAME = `/tmp/review-viewer-${UID}`;

  it('S2-9: 自分の所有・0700 の既存のものは再利用する', () => {
    const fake = makeFake({ ...BASE(), [NAME]: dir({ mode: 0o40700 }) });
    expect(resolveDataDir(makeDeps(fake))).toEqual({ dir: NAME, temporary: true });
  });

  it.each([0o40755, 0o40777, 0o40750, 0o40705, 0o40770, 0o40707])(
    'S2-9: 権限が緩い(%o)なら拒否する',
    (mode) => {
      const fake = makeFake({ ...BASE(), [NAME]: dir({ mode }) });
      expect(() => resolveDataDir(makeDeps(fake))).toThrow(/権限が緩すぎ/);
    }
  );

  it('S2-9: 他人の所有なら拒否する', () => {
    const fake = makeFake({ ...BASE(), [NAME]: dir({ uid: 0 }) });
    expect(() => resolveDataDir(makeDeps(fake))).toThrow(/他のユーザー/);
  });

  it('S2-9: シンボリックリンクなら(リンク先が 0700・自分の所有でも)拒否する', () => {
    const fake = makeFake({
      ...BASE(),
      '/elsewhere': dir(),
      [NAME]: { type: 'symlink', uid: UID, mode: 0o120777, target: '/elsewhere' },
    });
    expect(() => resolveDataDir(makeDeps(fake))).toThrow(/シンボリックリンク/);
  });

  it('S2-9: 壊れたシンボリックリンクでも拒否し、リンク先を作らない', () => {
    const fake = makeFake({
      ...BASE(),
      [NAME]: { type: 'symlink', uid: UID, mode: 0o120777, target: '/not-yet' },
    });
    expect(() => resolveDataDir(makeDeps(fake))).toThrow(/シンボリックリンク/);
    expect(fake.entries.has('/not-yet')).toBe(false);
  });

  it('S2-9: ディレクトリでない(ファイル)なら拒否する', () => {
    const fake = makeFake({ ...BASE(), [NAME]: { type: 'file', uid: UID, mode: 0o100600 } });
    expect(() => resolveDataDir(makeDeps(fake))).toThrow(/ディレクトリではありません/);
  });

  it('S2-9: 作成と確認の間に消えたら、確認できないエラーにする', () => {
    const fake = makeFake(BASE());
    const gone: DataDirFs = { ...fake.fs, mkdir: () => undefined, lstat: () => undefined };
    expect(() => resolveDataDir(makeDeps({ ...fake, fs: gone }))).toThrow(/確認できません/);
  });

  it('S2-9: 親(TMPDIR)が無いなどで作れなければ、理由つきでエラー', () => {
    const fake = makeFake(BASE(), 'ENOENT');
    expect(() => resolveDataDir(makeDeps(fake, { env: { TMPDIR: '/no/such' } }))).toThrow(/ENOENT/);
  });

  it('S2-9: 作成直後の確認で EEXIST になった既存のものも、同じ検査を通る(競合の対処)', () => {
    const fake = makeFake({ ...BASE(), [NAME]: dir({ mode: 0o40777 }) });
    expect(() => resolveDataDir(makeDeps(fake))).toThrow(/権限が緩すぎ/);
    expect(fake.made).toEqual([NAME]); // 先に作成を試み、既存だったので確認に進んだ
  });
});

describe('C-5: エラーの理由に、エラーコード以外の詳細を含めない', () => {
  it('C-5: 原因のエラーのメッセージ(パスやシステムの詳細)は出さず、コードだけを出す', () => {
    const fake = makeFake(BASE());
    const failing: DataDirFs = {
      ...fake.fs,
      stat: () => {
        throw Object.assign(new Error('EACCES: permission denied, stat SECRET_DETAIL'), { code: 'EACCES' });
      },
    };
    try {
      resolveDataDir(makeDeps({ ...fake, fs: failing }, { argDataDir: 'x' }));
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as Error).message).toContain('EACCES');
      expect((err as Error).message).not.toContain('SECRET_DETAIL');
    }
  });
});
