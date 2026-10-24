/**
 * 保存先の決定に使う、実際のファイル操作
 *
 * data-dir.ts に注入するための薄い実装。ユーザー指定のファイルを読むものではなく、
 * 保存先のディレクトリを確かめ、無ければ(親があれば)作るだけ。
 * ここは `ReviewStore.ts` と並んで、書き込み系の `fs` API を使ってよい場所(静的チェックで確認する)。
 * 書き込む対象は保存先のディレクトリ(の作成)だけで、対象リポジトリには触れない。
 */
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { resolveBaseDir } from './repo-dir.js';
import { resolveDataDir, type DataDirFs, type EntryInfo, type ResolvedDataDir } from './data-dir.js';

/**
 * Stats を、保存先の決定に使う情報にする
 *
 * @param st lstat または stat の結果
 * @returns 種類・所有者・権限
 */
function toInfo(st: Stats): EntryInfo {
  const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
  return { type, uid: st.uid, mode: st.mode };
}

/**
 * 「存在しない」を表すエラーか
 *
 * @param err 捕まえた値
 * @returns ENOENT または ENOTDIR なら true
 */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** 実際のファイルシステムを使う操作 */
export const realDataDirFs: DataDirFs = {
  lstat(path) {
    try {
      return toInfo(lstatSync(path));
    } catch (err: unknown) {
      if (isMissing(err)) return undefined;
      throw err;
    }
  },
  stat(path) {
    try {
      return toInfo(statSync(path));
    } catch (err: unknown) {
      if (isMissing(err)) return undefined;
      throw err;
    }
  },
  realpath(path) {
    return realpathSync(path);
  },
  mkdir(path, mode) {
    mkdirSync(path, { mode });
  },
  isWritable(path) {
    try {
      // 書き込み(W)と、中にファイルを作る・たどる(X)ができること
      accessSync(path, constants.W_OK | constants.X_OK);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES' || (err as NodeJS.ErrnoException).code === 'EROFS') {
        return false;
      }
      throw err;
    }
  },
};

/**
 * 実際のプロセスの環境変数・UID から、保存先を決める
 *
 * @param repoDir 決定済みの対象リポジトリ(絶対パス)
 * @param argDataDir `--data-dir` の値(未指定なら undefined)
 * @returns 使える保存先
 * @throws DataDirError 保存先が使えないとき
 */
export function resolveDataDirFromProcess(repoDir: string, argDataDir: string | undefined): ResolvedDataDir {
  return resolveDataDir({
    argDataDir,
    env: process.env,
    baseDir: resolveBaseDir(process.env, process.cwd()),
    repoDir,
    uid: process.getuid?.() ?? 0,
    fs: realDataDirFs,
  });
}
