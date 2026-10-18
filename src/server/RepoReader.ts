/**
 * RepoReader: 対象リポジトリ(REPO_DIR)からファイルを読む、唯一の入口(SPEC §2、CLAUDE.md ルール5)
 *
 * パスの検証を、このファイルに集める。ほかの場所で、利用者が指定したパスを `fs` から直接読まない。
 *
 * 検証の順序(1件のパスにつき):
 *  1. 文字列の検査(path-policy.ts): 絶対パス、`..`、バックスラッシュ、制御文字を拒否
 *  2. 指定された名前(リンク名)での秘密ファイルの判定 — ここまでは、ファイルシステムに触れない
 *  3. 実体のパス(realpath)を求め、リポジトリの中にあることを確認(シンボリックリンク対策)
 *  4. 実体のパスでの秘密ファイルの判定(リポジトリ内のリンクが秘密ファイルを指す場合)
 *  5. `.gitignore` の判定(実体のパスと、指定された名前の両方)
 *  6. 実体のパスを、末尾のリンクをたどらない指定で開き、開いたものが 3 で確認したものと
 *     同じであることを確かめてから読む(確認と読み取りの間の差し替え(TOCTOU)を、できる範囲で避ける)
 *
 * 拒否は、理由によらず `not_found` にする(存在しないパスと区別できないようにする。暫定の方針)。
 * リポジトリには書き込まない。
 */
import { constants, type Stats } from 'node:fs';
import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { GitignoreMatcher } from './gitignore.js';
import { hasSecretSegment, isSecretName, isValidSegment, parseRepoPath, RepoAccessError } from './path-policy.js';

/**
 * 本文を返すファイルの大きさの上限の既定値(バイト)
 *
 * 暫定の方針: 「1MB」は 1,048,576 バイト。ちょうどは返し、1 バイトでも超えたら返さない(S1-6)。
 */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/** `.gitignore` として読み込む大きさの上限(バイト)。超えたら、エラーにして止める */
export const MAX_GITIGNORE_BYTES = 1024 * 1024;

/** `.gitignore` のファイル名 */
const GITIGNORE_NAME = '.gitignore';

/** 1回の read で読む大きさ(バイト) */
const READ_CHUNK_BYTES = 64 * 1024;

/** 「存在しない」「たどれない」「読む権限が無い」を表すエラーコード。どれも `not_found` として扱う */
const MISSING_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'ENOTDIR',
  'ELOOP',
  'ENAMETOOLONG',
  'EACCES',
  'EPERM',
]);

/** RepoReader の設定 */
export interface RepoReaderOptions {
  /** 対象リポジトリのディレクトリ */
  readonly repoDir: string;
  /** 本文を返すファイルの大きさの上限(バイト)。省略時は `DEFAULT_MAX_FILE_BYTES` */
  readonly maxFileBytes?: number;
}

/** 一覧の1件の種類 */
export type RepoEntryType = 'file' | 'directory';

/** ディレクトリの一覧の1件 */
export interface RepoEntry {
  /** 名前(パスの最後の要素) */
  readonly name: string;
  /** リポジトリ相対パス(`/` 区切り) */
  readonly path: string;
  /** 種類 */
  readonly type: RepoEntryType;
  /** 大きさ(バイト)。リンクなら、指している先の大きさ */
  readonly size: number;
  /** 更新日時(エポックからのミリ秒)。リンクなら、指している先の更新日時 */
  readonly mtimeMs: number;
}

/** ディレクトリの一覧 */
export interface RepoDirectory {
  /** リポジトリ相対パス(ルートなら空文字列) */
  readonly path: string;
  /** 配下の一覧(1階層だけ。名前の昇順。拒否対象は含まない) */
  readonly entries: readonly RepoEntry[];
}

/** ファイルの内容。巨大ファイルとバイナリは、本文を持たない(S1-6) */
export type RepoFile =
  | { readonly path: string; readonly size: number; readonly kind: 'text'; readonly content: string }
  | { readonly path: string; readonly size: number; readonly kind: 'too_large'; readonly maxBytes: number }
  | { readonly path: string; readonly size: number; readonly kind: 'binary' };

/**
 * リポジトリを使えないとき(REPO_DIR が無い、など)のエラー
 *
 * メッセージに、ディレクトリのパスを含めない(C-5)。
 */
export class RepoUnavailableError extends Error {
  /**
   * @param cause 元のエラー(ログには出さない。デバッガで追うためだけに持つ)
   */
  constructor(cause: unknown) {
    super('対象リポジトリのディレクトリを使えません', { cause });
    this.name = 'RepoUnavailableError';
  }
}

/** 検証を通った、1件のパス */
interface ResolvedPath {
  /** リポジトリのルートの、実体のパス */
  readonly root: string;
  /** 指定されたパスの要素(リンクをたどる前) */
  readonly segments: readonly string[];
  /** 実体のパス(絶対パス。リポジトリの中にあることを確認済み) */
  readonly real: string;
  /** 実体のパスの、リポジトリ相対の要素 */
  readonly realSegments: readonly string[];
  /** 実体の情報(リンクをたどった先) */
  readonly stats: Stats;
}

/**
 * 捕まえた値から、Node.js のエラーコード(`ENOENT` など)を取り出す
 *
 * @param err 捕まえた値
 * @returns エラーコード。無ければ undefined
 */
function errorCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') return err.code;
  return undefined;
}

/**
 * 「存在しない」「たどれない」「読む権限が無い」のエラーかどうかを調べる
 *
 * @param err 捕まえた値
 * @returns 該当すれば true
 */
function isMissingError(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && MISSING_CODES.has(code);
}

/**
 * 実体のパスが、ルートの中(または、ルートそのもの)にあるかを調べ、相対パスの要素にする
 *
 * 文字列の前方一致だけで判定すると `/repo-evil` を `/repo` の中とみなしてしまうので、
 * 区切り文字まで含めて比べる。
 *
 * @param root ルートの実体のパス(絶対パス)
 * @param real 調べるパスの実体のパス(絶対パス)
 * @returns ルートからの相対パスの要素(ルートそのものなら空)。ルートの外なら null
 */
export function toRepoSegments(root: string, real: string): string[] | null {
  if (real === root) return [];
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!real.startsWith(prefix)) return null;
  return real.slice(prefix.length).split(sep);
}

/**
 * ファイルの中身をテキストとして読めるなら文字列にし、バイナリなら null を返す(S1-6)
 *
 * 拡張子ではなく、中身で判定する。NUL バイトを含むもの、UTF-8 として正しくないものを、
 * バイナリとする(UTF-16 や Shift_JIS のテキストも、この判定ではバイナリになる)。
 *
 * @param bytes ファイルの中身
 * @returns UTF-8 のテキストなら、その文字列(先頭の BOM は除く)。バイナリなら null
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    // fatal 指定の TextDecoder は、UTF-8 として正しくないと TypeError を投げる。
    // それは「バイナリである」という判定結果。ほかの例外は想定外なので、握りつぶさず投げ直す
    if (err instanceof TypeError) return null;
    throw err;
  }
}

/**
 * 開いたファイルを、先頭から `limit` バイトまで読む(ファイル全体を一度に確保しない)
 *
 * @param handle 開いたファイル
 * @param limit 読む上限(バイト)
 * @returns 読んだ中身(ファイルが `limit` より長ければ、ちょうど `limit` バイト)
 */
async function readUpTo(handle: FileHandle, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, limit - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

/**
 * 対象リポジトリからファイルを読む、唯一の入口
 */
export class RepoReader {
  private readonly repoDir: string;
  private readonly maxFileBytes: number;

  /**
   * @param options 対象リポジトリのディレクトリと、本文を返す大きさの上限
   * @throws RangeError 上限が 0 以上の整数でないとき
   */
  constructor(options: RepoReaderOptions) {
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0) {
      throw new RangeError('maxFileBytes は 0 以上の整数で指定してください');
    }
    this.repoDir = options.repoDir;
    this.maxFileBytes = maxFileBytes;
  }

  /**
   * ディレクトリの一覧を返す(1階層だけ。拒否対象は含めない)
   *
   * 含めないもの: 秘密ファイル、`.gitignore` の対象、リポジトリの外を指すリンク、
   * 指している先が無いリンク、通常のファイルでもディレクトリでもないもの(ソケットなど)。
   *
   * @param path リポジトリ相対パス(空文字列ならルート)
   * @returns 一覧(名前の昇順)
   * @throws RepoAccessError パスの形式が正しくない(`invalid_path`)、または
   *   存在しない・拒否対象・ディレクトリでない(いずれも `not_found`)とき
   * @throws RepoUnavailableError リポジトリのディレクトリを使えないとき
   */
  async listDirectory(path: string): Promise<RepoDirectory> {
    const matcher = this.createMatcher();
    const resolved = await this.resolve(path);
    if (!resolved.stats.isDirectory()) throw new RepoAccessError('not_found', 'not_a_directory');
    await this.assertNotIgnored(matcher, resolved, true);

    let names: string[];
    try {
      names = await readdir(resolved.real);
    } catch (err) {
      if (isMissingError(err)) throw new RepoAccessError('not_found', 'missing');
      throw err;
    }
    // 読んでいる間に、途中の要素がリンクに差し替えられていないことを確かめる
    await this.assertUnchanged(resolved);

    const inspected = await Promise.all(names.map((name) => this.inspectChild(matcher, resolved, name)));
    const entries = inspected.filter((entry): entry is RepoEntry => entry !== null);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { path: resolved.segments.join('/'), entries };
  }

  /**
   * ファイルの内容を返す。巨大ファイルとバイナリは、本文を返さず、その旨を返す(S1-6)
   *
   * 巨大ファイルは、大きさだけを見て判定する(中身をメモリに読み込まない)。
   *
   * @param path リポジトリ相対パス
   * @returns ファイルの内容(`kind` が `text` のときだけ本文を持つ)
   * @throws RepoAccessError パスの形式が正しくない(`invalid_path`)、または
   *   存在しない・拒否対象・通常のファイルでない(いずれも `not_found`)とき
   * @throws RepoUnavailableError リポジトリのディレクトリを使えないとき
   */
  async readFile(path: string): Promise<RepoFile> {
    const matcher = this.createMatcher();
    const resolved = await this.resolve(path);
    if (!resolved.stats.isFile()) throw new RepoAccessError('not_found', 'not_a_file');
    await this.assertNotIgnored(matcher, resolved, false);

    const logicalPath = resolved.segments.join('/');
    const handle = await this.openVerified(resolved);
    try {
      const { size } = await handle.stat();
      if (size > this.maxFileBytes) {
        return { path: logicalPath, size, kind: 'too_large', maxBytes: this.maxFileBytes };
      }
      // 大きさを調べた後にファイルが伸びても、上限 + 1 バイトまでしか読まない
      const bytes = await readUpTo(handle, this.maxFileBytes + 1);
      if (bytes.length > this.maxFileBytes) {
        return { path: logicalPath, size: bytes.length, kind: 'too_large', maxBytes: this.maxFileBytes };
      }
      const content = decodeText(bytes);
      if (content === null) return { path: logicalPath, size: bytes.length, kind: 'binary' };
      return { path: logicalPath, size: bytes.length, kind: 'text', content };
    } finally {
      await handle.close();
    }
  }

  /**
   * リポジトリのルートの、実体のパスを求める
   *
   * 毎回求める(起動後にマウントし直された場合などに、古い値を使い続けないため)。
   *
   * @returns ルートの実体のパス(絶対パス)
   * @throws RepoUnavailableError ルートを解決できないとき
   */
  private async resolveRoot(): Promise<string> {
    try {
      return await realpath(this.repoDir);
    } catch (err) {
      throw new RepoUnavailableError(err);
    }
  }

  /**
   * 利用者が指定したパスを検証して、実体のパスにする(検証の順序 1〜4)
   *
   * @param path 利用者が指定したパス
   * @returns 検証を通ったパス
   * @throws RepoAccessError 形式が正しくない、存在しない、リポジトリの外、秘密ファイルのとき
   * @throws RepoUnavailableError リポジトリのディレクトリを使えないとき
   */
  private async resolve(path: string): Promise<ResolvedPath> {
    const segments = parseRepoPath(path);
    // ファイルシステムに触れる前に、名前だけで秘密ファイルを拒否する
    // (存在するかどうかで、応答や処理時間が変わらないようにするため)
    if (hasSecretSegment(segments)) throw new RepoAccessError('not_found', 'secret');

    const root = await this.resolveRoot();
    let real: string;
    let stats: Stats;
    try {
      real = await realpath(join(root, ...segments));
      stats = await stat(real);
    } catch (err) {
      if (isMissingError(err)) throw new RepoAccessError('not_found', 'missing');
      throw err;
    }
    const realSegments = toRepoSegments(root, real);
    if (realSegments === null) throw new RepoAccessError('not_found', 'outside');
    if (hasSecretSegment(realSegments)) throw new RepoAccessError('not_found', 'secret');
    return { root, segments, real, realSegments, stats };
  }

  /**
   * `.gitignore` で除外されていたら拒否する(検証の順序 5)
   *
   * 実体のパスと、指定された名前(リンク名)の両方で調べる。
   *
   * @param matcher この操作の間だけ使う `.gitignore` の判定器
   * @param resolved 検証を通ったパス
   * @param isDirectory ディレクトリなら true
   * @returns なし
   * @throws RepoAccessError 除外されているとき(`not_found`)
   */
  private async assertNotIgnored(
    matcher: GitignoreMatcher,
    resolved: ResolvedPath,
    isDirectory: boolean
  ): Promise<void> {
    if (await this.isIgnored(matcher, resolved.segments, resolved.realSegments, isDirectory)) {
      throw new RepoAccessError('not_found', 'ignored');
    }
  }

  /**
   * 実体のパスか、指定された名前のどちらかが、`.gitignore` で除外されているかを調べる
   *
   * @param matcher `.gitignore` の判定器
   * @param segments 指定されたパスの要素
   * @param realSegments 実体のパスの要素
   * @param isDirectory ディレクトリなら true
   * @returns どちらかが除外されていれば true
   */
  private async isIgnored(
    matcher: GitignoreMatcher,
    segments: readonly string[],
    realSegments: readonly string[],
    isDirectory: boolean
  ): Promise<boolean> {
    if (await matcher.isIgnored(realSegments, isDirectory)) return true;
    if (segments.join('/') === realSegments.join('/')) return false;
    return matcher.isIgnored(segments, isDirectory);
  }

  /**
   * 実体のパスを、末尾のリンクをたどらない指定で開き、検証したものと同じであることを確かめる
   * (検証の順序 6)
   *
   * @param resolved 検証を通ったパス(通常のファイル)
   * @returns 開いたファイル。呼び出し側が閉じること
   * @throws RepoAccessError 開けない、または、検証の後に差し替えられていたとき(`not_found`)
   */
  private async openVerified(resolved: ResolvedPath): Promise<FileHandle> {
    let handle: FileHandle;
    try {
      // O_NOFOLLOW: 末尾がリンクに差し替えられていたら、たどらずに失敗する(ELOOP)
      // O_NONBLOCK: 名前付きパイプなどに差し替えられていても、開く処理で止まらない
      handle = await open(resolved.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      if (isMissingError(err)) throw new RepoAccessError('not_found', 'changed');
      throw err;
    }
    try {
      const opened = await handle.stat();
      const same =
        opened.isFile() && opened.dev === resolved.stats.dev && opened.ino === resolved.stats.ino;
      if (!same) throw new RepoAccessError('not_found', 'changed');
      await this.assertUnchanged(resolved);
      return handle;
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  /**
   * 検証した実体のパスが、いまも同じ場所を指していることを確かめる
   *
   * 途中のディレクトリがリンクに差し替えられると、実体のパスが変わる。
   *
   * @param resolved 検証を通ったパス
   * @returns なし
   * @throws RepoAccessError 実体のパスが変わっていたとき(`not_found`)
   */
  private async assertUnchanged(resolved: ResolvedPath): Promise<void> {
    let current: string;
    try {
      current = await realpath(resolved.real);
    } catch (err) {
      if (isMissingError(err)) throw new RepoAccessError('not_found', 'changed');
      throw err;
    }
    if (current !== resolved.real) throw new RepoAccessError('not_found', 'changed');
  }

  /**
   * 一覧に載せる1件を調べる。載せてはいけないものは null を返す
   *
   * 名前がリンクでもそうでなくても、実体のパスを求めて、同じ検証(リポジトリの中か、
   * 秘密ファイルでないか、`.gitignore` の対象でないか)を行う。
   *
   * @param matcher `.gitignore` の判定器
   * @param parent 親ディレクトリ(検証を通ったもの)
   * @param name 配下の名前
   * @returns 一覧の1件。載せないなら null
   */
  private async inspectChild(
    matcher: GitignoreMatcher,
    parent: ResolvedPath,
    name: string
  ): Promise<RepoEntry | null> {
    // API から指定できない名前(制御文字やバックスラッシュを含む)は、載せても開けないので除く
    if (!isValidSegment(name) || isSecretName(name)) return null;

    let real: string;
    let stats: Stats;
    try {
      real = await realpath(join(parent.real, name));
      stats = await stat(real);
    } catch (err) {
      // 指している先が無いリンク、一覧の取得後に消えたファイルなど
      if (isMissingError(err)) return null;
      throw err;
    }
    const realSegments = toRepoSegments(parent.root, real);
    if (realSegments === null || hasSecretSegment(realSegments)) return null;

    const type: RepoEntryType | null = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : null;
    if (type === null) return null;

    const segments = [...parent.segments, name];
    if (await this.isIgnored(matcher, segments, realSegments, type === 'directory')) return null;
    return { name, path: segments.join('/'), type, size: stats.size, mtimeMs: stats.mtimeMs };
  }

  /**
   * この操作の間だけ使う、`.gitignore` の判定器を作る
   *
   * @returns 判定器(読み込んだ `.gitignore` を、操作の間だけ覚えている)
   */
  private createMatcher(): GitignoreMatcher {
    return new GitignoreMatcher((dirSegments) => this.loadIgnoreRules(dirSegments));
  }

  /**
   * あるディレクトリの `.gitignore` の中身を読む
   *
   * 次の場合は「無い」として扱う(null)。
   * - `.gitignore` が無い、またはディレクトリがたどれない
   * - ディレクトリの実体が、リポジトリの外にある(外にある規則は使わない)
   * - `.gitignore` がシンボリックリンク、または通常のファイルでない(git もリンクはたどらない)
   *
   * 権限が無くて読めない、大きすぎる、などの場合は、除外の判定ができないので、
   * 通さずにエラーにする(安全側に倒す)。
   *
   * @param dirSegments ディレクトリの、リポジトリ相対パスの要素(ルートなら空)
   * @returns `.gitignore` の中身。無ければ null
   * @throws `.gitignore` があるのに読めないとき
   */
  private async loadIgnoreRules(dirSegments: readonly string[]): Promise<string | null> {
    const root = await this.resolveRoot();
    let handle: FileHandle;
    try {
      const dir = await realpath(join(root, ...dirSegments));
      if (toRepoSegments(root, dir) === null) return null;
      handle = await open(
        join(dir, GITIGNORE_NAME),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
    } catch (err) {
      const code = errorCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') return null;
      throw new Error('.gitignore を読み込めません', { cause: err });
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return null;
      const bytes = await readUpTo(handle, MAX_GITIGNORE_BYTES + 1);
      if (bytes.length > MAX_GITIGNORE_BYTES) throw new Error('.gitignore が大きすぎます');
      return bytes.toString('utf8');
    } finally {
      await handle.close();
    }
  }
}
