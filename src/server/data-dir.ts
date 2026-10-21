/**
 * コメントの保存先の決め方(SPEC §2.5「保存先の決め方」、S2-9)
 *
 * 決める順番: 起動時の引数 `--data-dir` → 環境変数 `DATA_DIR` → `/data`(存在する場合)
 * → OS の一時ディレクトリの下の `review-viewer-<UID>`。
 *
 * - 1・2 で指定されたパスが使えない(作れない、書けない、ディレクトリでない、対象リポジトリの中)ときは、
 *   **次の候補へ進まず**にエラーにする(指定の誤りに気づけるようにするため)
 * - 1・2 で指定されたパスが無ければ、親ディレクトリがあるときだけ、そのディレクトリを作る(親は作らない)
 * - 4 は 0700 で作り、すでにあるものは、シンボリックリンク・他人の所有・緩い権限を拒否する
 *
 * 副作用(ファイルシステム、環境変数、UID)はすべて引数で受け取り、単体テストで各分岐を確かめる。
 * 実際のファイル操作は data-dir-io.ts に置く。このファイルは `fs` に触れない。
 */
import { basename, dirname, join, resolve, sep } from 'node:path';

/** パスの種類(シンボリックリンクをたどらない lstat の分類) */
export type EntryType = 'directory' | 'symlink' | 'file' | 'other';

/** ファイルシステム上の1件の情報 */
export interface EntryInfo {
  /** 種類 */
  readonly type: EntryType;
  /** 所有者の UID */
  readonly uid: number;
  /** 権限ビット(`mode & 0o777` の範囲を含む値) */
  readonly mode: number;
}

/** 保存先の決定に使うファイルシステムの操作(同期。テストで差し替える) */
export interface DataDirFs {
  /**
   * シンボリックリンクをたどらずに調べる
   * @param path 調べるパス
   * @returns 情報。存在しなければ undefined(ENOENT 以外の失敗は例外)
   */
  lstat(path: string): EntryInfo | undefined;
  /**
   * シンボリックリンクをたどって調べる
   * @param path 調べるパス
   * @returns 情報。存在しなければ undefined(ENOENT/ENOTDIR 以外の失敗は例外)
   */
  stat(path: string): EntryInfo | undefined;
  /**
   * 実体のパスを求める
   * @param path 存在するパス
   * @returns 実体の絶対パス(失敗は例外)
   */
  realpath(path: string): string;
  /**
   * ディレクトリを1つ作る(親は作らない)
   * @param path 作るパス
   * @param mode 権限
   * @returns なし(すでにあれば `code === 'EEXIST'` の例外)
   */
  mkdir(path: string, mode: number): void;
  /**
   * ディレクトリに書き込めるか調べる
   * @param path ディレクトリ
   * @returns 書き込んでファイルを作れるなら true
   */
  isWritable(path: string): boolean;
}

/** 保存先の決定に必要なもの */
export interface DataDirDeps {
  /** `--data-dir` の値(未指定なら undefined) */
  readonly argDataDir: string | undefined;
  /** 環境変数 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 相対パスの基準にするディレクトリ(コマンドを実行したディレクトリ) */
  readonly baseDir: string;
  /** 決定済みの対象リポジトリ(絶対パス) */
  readonly repoDir: string;
  /** 実行ユーザーの UID */
  readonly uid: number;
  /** ファイルシステムの操作 */
  readonly fs: DataDirFs;
}

/** 決まった保存先 */
export interface ResolvedDataDir {
  /** 保存先のディレクトリ(絶対パス) */
  readonly dir: string;
  /** OS の一時ディレクトリの下(消えることがある)なら true */
  readonly temporary: boolean;
}

/** 既定の保存先(コンテナの既定) */
export const DEFAULT_DATA_PATH = '/data';
/** 一時ディレクトリの下の保存先の名前の接頭辞 */
export const TEMP_DIR_PREFIX = 'review-viewer-';
/** 作るディレクトリの権限(所有者だけ) */
const PRIVATE_DIR_MODE = 0o700;

/** 保存先を決められなかったときのエラー。メッセージは、利用者にそのまま見せる理由 */
export class DataDirError extends Error {
  /**
   * @param message 理由(秘密を含めない。C-5)
   */
  constructor(message: string) {
    super(message);
    this.name = 'DataDirError';
  }
}

/**
 * 失敗の原因から、表示してよいエラーコード(`EACCES` など)を取り出す
 *
 * メッセージ全体は出さない(パスやシステムの詳細を含むため)。
 *
 * @param err 捕まえた値
 * @returns エラーコード。無い、または想定外の形なら `不明`
 */
function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = err.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  }
  return '不明';
}

/**
 * 操作を実行し、失敗を DataDirError にする
 *
 * @param what 何をしたか(例: `作成`)
 * @param label 保存先の指定元(例: `--data-dir`)
 * @param path 対象のパス(利用者が指定したもの)
 * @param action 実行する操作
 * @returns 操作の戻り値
 * @throws DataDirError 操作が失敗したとき(原因のエラーコードだけを理由に含める)
 */
function attempt<T>(what: string, label: string, path: string, action: () => T): T {
  try {
    return action();
  } catch (err: unknown) {
    throw new DataDirError(`${label} の保存先 ${path} を${what}できません(${errorCode(err)})`);
  }
}

/**
 * 実体のパスが、対象リポジトリの中(またはそのもの)かを調べる
 *
 * 前方一致だけだと `/repo-evil` を `/repo` の中とみなすので、区切り文字まで含めて比べる。
 *
 * @param repoReal 対象リポジトリの実体のパス
 * @param real 調べる実体のパス
 * @returns 中(またはそのもの)なら true
 */
function isInside(repoReal: string, real: string): boolean {
  if (real === repoReal) return true;
  const prefix = repoReal.endsWith(sep) ? repoReal : repoReal + sep;
  return real.startsWith(prefix);
}

/**
 * 環境変数の値を取り出す。未設定と、空白だけの値は、同じ「未設定」として扱う
 *
 * @param env 環境変数
 * @param name 名前
 * @returns 前後の空白を除いた値。未設定または空なら undefined
 */
function readEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * ディレクトリを調べ、使えるか(書けるか、対象リポジトリの外か)を確かめる共通の処理
 *
 * @param dir 保存先(存在するもの)
 * @param label 保存先の指定元
 * @param repoReal 対象リポジトリの実体のパス
 * @param deps 依存
 * @returns 実体のパス
 * @throws DataDirError ディレクトリでない、リポジトリの中、書き込めないとき
 */
function verifyUsable(dir: string, label: string, repoReal: string, deps: DataDirDeps): string {
  const st = attempt('調べることが', label, dir, () => deps.fs.stat(dir));
  if (st === undefined) throw new DataDirError(`${label} の保存先 ${dir} が存在しません`);
  if (st.type !== 'directory') throw new DataDirError(`${label} の保存先 ${dir} はディレクトリではありません`);
  const real = attempt('調べることが', label, dir, () => deps.fs.realpath(dir));
  if (isInside(repoReal, real)) {
    throw new DataDirError(`${label} の保存先 ${dir} は対象リポジトリの中にあります。リポジトリの外を指定してください`);
  }
  if (!attempt('調べることが', label, dir, () => deps.fs.isWritable(real))) {
    throw new DataDirError(`${label} の保存先 ${dir} に書き込めません`);
  }
  return real;
}

/**
 * 利用者が指定した保存先(1・2)、または `/data`(3)を使えるようにする
 *
 * @param path 絶対パス
 * @param label 保存先の指定元(`--data-dir`、`DATA_DIR`、`/data`)
 * @param create 無いときに(親があれば)作るなら true
 * @param repoReal 対象リポジトリの実体のパス
 * @param deps 依存
 * @returns 使える保存先の絶対パス
 * @throws DataDirError 使えないとき(次の候補へは進まない)
 */
function useConfigured(
  path: string,
  label: string,
  create: boolean,
  repoReal: string,
  deps: DataDirDeps
): string {
  const found = attempt('調べることが', label, path, () => deps.fs.stat(path));
  if (found === undefined) {
    if (!create) throw new DataDirError(`${label} の保存先 ${path} が存在しません`);
    // リンク切れのシンボリックリンクは、作らずに止める(リンク先を勝手に作らない)
    const link = attempt('調べることが', label, path, () => deps.fs.lstat(path));
    if (link !== undefined) throw new DataDirError(`${label} の保存先 ${path} はリンク切れです`);
    const parent = dirname(path);
    const parentInfo = attempt('調べることが', label, parent, () => deps.fs.stat(parent));
    if (parentInfo === undefined || parentInfo.type !== 'directory') {
      throw new DataDirError(`${label} の保存先 ${path} の親ディレクトリが存在しません(親は作りません)`);
    }
    // 作る前に、作る先が対象リポジトリの中でないことを確かめる(リポジトリの中に作らない)
    const parentReal = attempt('調べることが', label, parent, () => deps.fs.realpath(parent));
    if (isInside(repoReal, join(parentReal, basename(path)))) {
      throw new DataDirError(`${label} の保存先 ${path} は対象リポジトリの中にあります。リポジトリの外を指定してください`);
    }
    try {
      deps.fs.mkdir(path, PRIVATE_DIR_MODE);
    } catch (err: unknown) {
      // 確認から作成までの間に作られたときは、既存のものとして確認に進む
      if (errorCode(err) !== 'EEXIST') {
        throw new DataDirError(`${label} の保存先 ${path} を作成できません(${errorCode(err)})`);
      }
    }
  }
  return verifyUsable(path, label, repoReal, deps);
}

/**
 * OS の一時ディレクトリの下の保存先(4)を、作って使えるようにする
 *
 * 作成と確認の間の競合を避けるため、先に 0700 で作り、失敗(すでにある)したら確認に進む。
 * 確認は lstat で行い、シンボリックリンク・他人の所有・グループや他人に権限があるものを拒否する。
 * 返すのは実体のパス(確認した後で、パスの先が差し替えられても書き込み先が変わらないように)。
 *
 * @param repoReal 対象リポジトリの実体のパス
 * @param deps 依存
 * @returns 使える保存先の実体のパス
 * @throws DataDirError 作れない、または既存のものが安全でないとき
 */
function useTemporary(repoReal: string, deps: DataDirDeps): string {
  const tmpRoot = resolve(deps.baseDir, readEnv(deps.env, 'TMPDIR') ?? '/tmp');
  const path = join(tmpRoot, `${TEMP_DIR_PREFIX}${deps.uid}`);
  const label = '一時ディレクトリ';
  try {
    deps.fs.mkdir(path, PRIVATE_DIR_MODE);
  } catch (err: unknown) {
    if (errorCode(err) !== 'EEXIST') {
      throw new DataDirError(`${label}の保存先 ${path} を作成できません(${errorCode(err)})`);
    }
  }
  const info = attempt('調べることが', label, path, () => deps.fs.lstat(path));
  if (info === undefined) throw new DataDirError(`${label}の保存先 ${path} が確認できません(作成直後に消えました)`);
  if (info.type === 'symlink') {
    throw new DataDirError(`${label}の保存先 ${path} はシンボリックリンクです。安全のため使いません`);
  }
  if (info.type !== 'directory') throw new DataDirError(`${label}の保存先 ${path} はディレクトリではありません`);
  if (info.uid !== deps.uid) {
    throw new DataDirError(`${label}の保存先 ${path} は他のユーザーの所有です。安全のため使いません`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new DataDirError(
      `${label}の保存先 ${path} の権限が緩すぎます(グループ・他人に権限があります)。所有者だけ(0700)にしてください`
    );
  }
  return verifyUsable(path, label, repoReal, deps);
}

/**
 * コメントの保存先を決める(SPEC §2.5)
 *
 * @param deps 引数、環境変数、基準ディレクトリ、対象リポジトリ、UID、ファイルシステムの操作
 * @returns 使える保存先(一時ディレクトリなら `temporary: true`)
 * @throws DataDirError 指定された保存先が使えないとき、または 3・4 が使えないとき
 */
export function resolveDataDir(deps: DataDirDeps): ResolvedDataDir {
  const repoReal = attempt('調べることが', '対象リポジトリ', deps.repoDir, () => deps.fs.realpath(deps.repoDir));

  // 1. 起動時の引数 --data-dir
  if (deps.argDataDir !== undefined) {
    const path = resolve(deps.baseDir, deps.argDataDir);
    return { dir: useConfigured(path, '--data-dir', true, repoReal, deps), temporary: false };
  }

  // 2. 環境変数 DATA_DIR(空白だけの値は未設定として扱う。config.ts と同じ)
  const envValue = readEnv(deps.env, 'DATA_DIR');
  if (envValue !== undefined) {
    const path = resolve(deps.baseDir, envValue);
    return { dir: useConfigured(path, 'DATA_DIR', true, repoReal, deps), temporary: false };
  }

  // 3. /data(存在する場合。コンテナの既定。作らない)
  const def = attempt('調べることが', DEFAULT_DATA_PATH, DEFAULT_DATA_PATH, () => deps.fs.stat(DEFAULT_DATA_PATH));
  if (def !== undefined) {
    return { dir: useConfigured(DEFAULT_DATA_PATH, DEFAULT_DATA_PATH, false, repoReal, deps), temporary: false };
  }

  // 4. OS の一時ディレクトリの下
  return { dir: useTemporary(repoReal, deps), temporary: true };
}
