/**
 * 単体テスト用の、一時的なフィクスチャのリポジトリ
 *
 * 秘密ファイルに「見える」ダミーやシンボリックリンクは、このリポジトリ自身の .gitignore に
 * 一致するのでコミットできない。そのため、テストのたびに OS の一時ディレクトリへ作り、
 * テストの後で消す。中身は、すべて明らかなダミーの文字列(本物の秘密は含まない)。
 *
 * e2e/fixtures/ とは別物(単体テスト用は Coder が、システムテスト用は Tester が用意する)。
 */
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** 一時的なフィクスチャのリポジトリ */
export interface TempRepo {
  /** 一時ディレクトリの最上位(この中に、リポジトリと「リポジトリの外」を作る) */
  readonly baseDir: string;
  /** リポジトリのルート(REPO_DIR にあたる) */
  readonly repoDir: string;
  /** リポジトリの外のディレクトリ(リポジトリの隣) */
  readonly outsideDir: string;
  /**
   * リポジトリの中にファイルを作る(親ディレクトリも作る)
   * @param path リポジトリ相対パス
   * @param content 中身
   * @returns 作ったファイルの絶対パス
   */
  write(path: string, content: string | Uint8Array): Promise<string>;
  /**
   * リポジトリの外にファイルを作る
   * @param path `outsideDir` からの相対パス
   * @param content 中身
   * @returns 作ったファイルの絶対パス
   */
  writeOutside(path: string, content: string | Uint8Array): Promise<string>;
  /**
   * リポジトリの中にシンボリックリンクを作る
   * @param target リンクの指す先(絶対パス、または、リンクの場所からの相対パス)
   * @param path リンクを置く、リポジトリ相対パス
   * @returns なし
   */
  link(target: string, path: string): Promise<void>;
  /**
   * リポジトリの中のファイルの更新日時を変える
   * @param path リポジトリ相対パス
   * @param date 更新日時
   * @returns なし
   */
  setMtime(path: string, date: Date): Promise<void>;
  /**
   * 一時ディレクトリを、まるごと消す
   * @returns なし
   */
  cleanup(): Promise<void>;
}

/**
 * ファイルを作る(親ディレクトリも作る)
 *
 * @param fullPath 作るファイルの絶対パス
 * @param content 中身
 * @returns 作ったファイルの絶対パス
 */
async function writeWithParents(fullPath: string, content: string | Uint8Array): Promise<string> {
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  return fullPath;
}

/**
 * 一時的なフィクスチャのリポジトリを作る(空のリポジトリと、その隣の「外」のディレクトリ)
 *
 * @returns 作ったリポジトリ。使い終わったら `cleanup()` を呼ぶこと
 */
export async function createTempRepo(): Promise<TempRepo> {
  const baseDir = await mkdtemp(join(tmpdir(), 'rv-unit-'));
  const repoDir = join(baseDir, 'repo');
  const outsideDir = join(baseDir, 'outside');
  await mkdir(repoDir);
  await mkdir(outsideDir);

  return {
    baseDir,
    repoDir,
    outsideDir,
    write: (path, content) => writeWithParents(join(repoDir, path), content),
    writeOutside: (path, content) => writeWithParents(join(outsideDir, path), content),
    link: async (target, path) => {
      const fullPath = join(repoDir, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await symlink(target, fullPath);
    },
    setMtime: (path, date) => utimes(join(repoDir, path), date, date),
    cleanup: () => rm(baseDir, { recursive: true, force: true }),
  };
}
