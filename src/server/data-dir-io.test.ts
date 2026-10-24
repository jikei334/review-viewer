/**
 * T2-2: 保存先の決定の、実際のファイルシステムでの確認(SPEC §2.5、S2-9)
 *
 * 一時ディレクトリの中だけで行う。権限の確認は root では成り立たないので飛ばす。
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataDirError, resolveDataDir } from './data-dir.js';
import { realDataDirFs } from './data-dir-io.js';

const IS_ROOT = process.getuid?.() === 0;
const UID = process.getuid?.() ?? 0;

let base = '';
let repo = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'rv-unit-dd-')));
  repo = join(base, 'repo');
  mkdirSync(repo);
  mkdirSync(join(base, 'tmp'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/**
 * 実際のファイルシステムで保存先を決める
 *
 * @param over 引数と環境変数
 * @returns 決まった保存先
 */
function resolveReal(over: { arg?: string; env?: Record<string, string> }): ReturnType<typeof resolveDataDir> {
  return resolveDataDir({
    argDataDir: over.arg,
    env: { TMPDIR: join(base, 'tmp'), ...over.env },
    baseDir: base,
    repoDir: repo,
    uid: UID,
    fs: realDataDirFs,
  });
}

describe('S2-9: 実際のファイルシステムでの保存先の決定', () => {
  it('S2-9: 無い保存先は、親があれば 0700 で作られる', () => {
    const r = resolveReal({ arg: 'new-dir' });
    expect(r).toEqual({ dir: join(base, 'new-dir'), temporary: false });
    expect(statSync(r.dir).mode & 0o777).toBe(0o700);
  });

  it('S2-9: 親が無ければ作らずに失敗する', () => {
    expect(() => resolveReal({ arg: 'a/b' })).toThrow(DataDirError);
    expect(() => statSync(join(base, 'a'))).toThrow();
  });

  it('S2-9: 対象リポジトリの中は、作らずに失敗する', () => {
    expect(() => resolveReal({ arg: join(repo, 'new') })).toThrow(/対象リポジトリの中/);
    expect(() => statSync(join(repo, 'new'))).toThrow();
  });

  it('S2-9: 一時ディレクトリは review-viewer-<UID> が 0700 で作られ、再利用できる', () => {
    const first = resolveReal({});
    expect(first.temporary).toBe(true);
    expect(first.dir).toBe(join(base, 'tmp', `review-viewer-${UID}`));
    expect(statSync(first.dir).mode & 0o777).toBe(0o700);
    expect(resolveReal({}).dir).toBe(first.dir);
  });

  it.skipIf(IS_ROOT)('S2-9: 一時ディレクトリの既存のものの権限が緩ければ拒否する', () => {
    const path = join(base, 'tmp', `review-viewer-${UID}`);
    mkdirSync(path);
    chmodSync(path, 0o755);
    expect(() => resolveReal({})).toThrow(/権限が緩すぎ/);
  });

  it('S2-9: 一時ディレクトリの既存のものがシンボリックリンクなら拒否する', () => {
    const target = join(base, 'target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(base, 'tmp', `review-viewer-${UID}`));
    expect(() => resolveReal({})).toThrow(/シンボリックリンク/);
  });

  it('S2-9: ファイルを保存先に指定すると失敗する', () => {
    writeFileSync(join(base, 'a-file'), 'x');
    expect(() => resolveReal({ arg: 'a-file' })).toThrow(/ディレクトリではありません/);
  });

  it.skipIf(IS_ROOT)('S2-9: 書き込めないディレクトリは失敗する', () => {
    const ro = join(base, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      expect(() => resolveReal({ arg: 'ro' })).toThrow(/書き込めません/);
    } finally {
      chmodSync(ro, 0o700);
    }
  });
});
