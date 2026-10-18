/**
 * 対象リポジトリの決め方(SPEC §2.5「対象リポジトリの決め方」、S1-10)
 *
 * 決める順番: 起動時の引数 → 環境変数 REPO_DIR → 既定の /repo(存在する場合)
 * → 標準入力が端末なら入力を求める → 端末でなければ理由を示して失敗する。
 *
 * 引数と環境変数は、`npm start -- <パス>` や `REPO_DIR` に使う値であり、起動時の設定の検証である。
 * ユーザーが API 越しに指定するファイルパスの読み取りではないので、RepoReader の対象ではない
 * (ここでは「存在するディレクトリか」を調べるだけで、中身は読まない)。
 * 副作用(ファイルシステム、端末、環境変数)はすべて引数で受け取り、単体テストで各分岐を確かめられるようにする。
 */
import { isAbsolute, resolve } from 'node:path';

/** パスの種類の判定結果 */
export type PathKind = 'directory' | 'not_found' | 'not_directory' | 'unreadable';

/** 対象リポジトリの決定に必要なもの(副作用はここから注入する) */
export interface RepoDirDeps {
  /** 起動時の引数(`npm start --` の後ろ。`process.argv.slice(2)`) */
  readonly args: readonly string[];
  /** 環境変数 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 相対パスの基準にするディレクトリ(利用者がコマンドを実行したディレクトリ) */
  readonly baseDir: string;
  /**
   * パスの種類を調べる(シンボリックリンクはたどる)
   * @param path 調べるパス(絶対パス)
   * @returns 判定結果
   */
  readonly inspect: (path: string) => PathKind;
  /** 標準入力が端末(TTY)かどうか */
  readonly isInteractive: boolean;
  /**
   * 端末で、パスの入力を求める
   * @param question 表示する質問(直前の失敗の理由を含むことがある)
   * @returns 入力された1行。入力が閉じられた・中断されたときは undefined
   */
  readonly prompt: (question: string) => Promise<string | undefined>;
}

/** 既定の対象リポジトリ */
export const DEFAULT_REPO_PATH = '/repo';

/** 対象リポジトリを決められなかったときのエラー。メッセージは、利用者にそのまま見せる理由 */
export class RepoDirError extends Error {
  /**
   * @param message 理由(秘密を含めない。C-5)
   */
  constructor(message: string) {
    super(message);
    this.name = 'RepoDirError';
  }
}

/** 端末での入力が中断された(入力が閉じられた、Ctrl-C など)ときのエラー。異常ではなく利用者の意思 */
export class RepoDirCancelledError extends Error {
  constructor() {
    super('入力が中断されました');
    this.name = 'RepoDirCancelledError';
  }
}

/**
 * 相対パスの基準ディレクトリを決める
 *
 * npm 経由で起動すると、cwd は package.json のあるディレクトリに変わる。
 * 利用者が実行した場所は、npm が設定する INIT_CWD に入っている。
 *
 * @param env 環境変数
 * @param cwd 現在のディレクトリ(`process.cwd()`)
 * @returns INIT_CWD が絶対パスで設定されていればそれ、なければ cwd
 */
export function resolveBaseDir(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string
): string {
  const initCwd = env['INIT_CWD']?.trim();
  return initCwd !== undefined && initCwd !== '' && isAbsolute(initCwd) ? initCwd : cwd;
}

/**
 * 種類を、利用者に見せる理由にする
 *
 * @param kind 判定結果('directory' 以外)
 * @returns 理由の文字列
 */
function describeKind(kind: Exclude<PathKind, 'directory'>): string {
  switch (kind) {
    case 'not_found':
      return '存在しません';
    case 'not_directory':
      return 'ディレクトリではありません';
    case 'unreadable':
      return '調べられません(権限など)';
  }
}

/**
 * パスを絶対パスにして、存在するディレクトリか確かめる
 *
 * @param raw 指定されたパス
 * @param deps baseDir と inspect
 * @returns 成功なら `{ ok: true, path }`、失敗なら理由
 */
function check(
  raw: string,
  deps: Pick<RepoDirDeps, 'baseDir' | 'inspect'>
): { ok: true; path: string } | { ok: false; kind: Exclude<PathKind, 'directory'>; reason: string } {
  const path = resolve(deps.baseDir, raw);
  const kind = deps.inspect(path);
  if (kind === 'directory') return { ok: true, path };
  return { ok: false, kind, reason: `${path} は${describeKind(kind)}` };
}

/**
 * 対象リポジトリを決める(SPEC §2.5)
 *
 * @param deps 引数、環境変数、基準ディレクトリ、ファイルシステムの確認、端末と入力
 * @returns 存在するディレクトリの絶対パス
 * @throws RepoDirError 引数・環境変数のパスが不正なとき、または決まらず端末でもないとき
 * @throws RepoDirCancelledError 入力が中断されたとき
 */
export async function resolveRepoDir(deps: RepoDirDeps): Promise<string> {
  // 1. 起動時の引数。不正なら入力には進まない
  if (deps.args.length > 1) {
    throw new RepoDirError('引数が多すぎます。対象リポジトリのパスは1つだけ指定してください');
  }
  const arg = deps.args[0];
  if (arg !== undefined) {
    if (arg.trim() === '') throw new RepoDirError('引数のパスが空です');
    const r = check(arg, deps);
    if (!r.ok) throw new RepoDirError(`引数で指定した対象リポジトリ: ${r.reason}`);
    return r.path;
  }

  // 2. 環境変数 REPO_DIR(空白だけの値は未設定として扱う。config.ts と同じ)
  const envValue = deps.env['REPO_DIR']?.trim();
  if (envValue !== undefined && envValue !== '') {
    const r = check(envValue, deps);
    if (!r.ok) throw new RepoDirError(`REPO_DIR で指定した対象リポジトリ: ${r.reason}`);
    return r.path;
  }

  // 3. 既定の /repo(存在するときだけ)
  const def = check(DEFAULT_REPO_PATH, deps);
  if (def.ok) return def.path;

  // 5. 端末でなければ、入力を求められないので失敗する
  if (!deps.isInteractive) {
    throw new RepoDirError(
      '対象リポジトリが決まりません。引数(npm start -- <パス>)か環境変数 REPO_DIR で指定してください' +
        `(既定の ${DEFAULT_REPO_PATH} は${describeKind(def.kind)})`
    );
  }

  // 4. 端末なら、存在するディレクトリが入力されるまで聞き直す
  let question = '対象リポジトリのパスを入力してください: ';
  for (;;) {
    const answer = await deps.prompt(question);
    if (answer === undefined) throw new RepoDirCancelledError();
    const trimmed = answer.trim();
    if (trimmed === '') {
      question = 'パスが空です。対象リポジトリのパスを入力してください: ';
      continue;
    }
    const r = check(trimmed, deps);
    if (r.ok) return r.path;
    question = `${r.reason}。もう一度入力してください: `;
  }
}
