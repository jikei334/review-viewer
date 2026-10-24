/**
 * 起動時の引数の解析(SPEC §2.5)
 *
 * `npm start -- <リポジトリ> --data-dir <パス>` の引数を、位置引数(対象リポジトリ)と
 * `--data-dir`(保存先)に分ける。副作用のない関数だけを置く。
 *
 * 受け付ける形: `--data-dir <パス>` と `--data-dir=<パス>`。位置引数と併用でき、順序は問わない。
 * 単独の `--` 以降は、`--` で始まるものも位置引数として扱う。
 * 未知の `--` で始まるオプション、`--data-dir` の重複、値の欠落・空は、黙って無視せずエラーにする
 * (指定の誤りに気づけるようにするため)。
 */

/** 解析した起動時の引数 */
export interface LaunchArgs {
  /** 位置引数(対象リポジトリのパス。個数の検査は対象リポジトリの決定側で行う) */
  readonly positional: readonly string[];
  /** `--data-dir` で指定された保存先(未指定なら undefined) */
  readonly dataDir: string | undefined;
}

/** 起動時の引数が不正なときのエラー。メッセージは、利用者にそのまま見せる理由 */
export class LaunchArgsError extends Error {
  /**
   * @param message 理由(引数の値そのものは含めない。C-5)
   */
  constructor(message: string) {
    super(message);
    this.name = 'LaunchArgsError';
  }
}

/** 保存先を指定するオプションの名前 */
const DATA_DIR_OPTION = '--data-dir';

/**
 * 起動時の引数を解析する
 *
 * @param args 起動時の引数(`process.argv.slice(2)`)
 * @returns 位置引数と、`--data-dir` の値
 * @throws LaunchArgsError 未知のオプション、`--data-dir` の重複・値の欠落・空のとき
 */
export function parseLaunchArgs(args: readonly string[]): LaunchArgs {
  const positional: string[] = [];
  let dataDir: string | undefined;

  /**
   * `--data-dir` の値を記録する
   *
   * @param value 指定された値
   * @returns なし
   * @throws LaunchArgsError 重複、または空のとき
   */
  const setDataDir = (value: string): void => {
    if (dataDir !== undefined) throw new LaunchArgsError(`${DATA_DIR_OPTION} が複数指定されています`);
    if (value.trim() === '') throw new LaunchArgsError(`${DATA_DIR_OPTION} のパスが空です`);
    dataDir = value;
  };

  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (optionsEnded || !arg.startsWith('--')) {
      positional.push(arg);
    } else if (arg === '--') {
      optionsEnded = true;
    } else if (arg === DATA_DIR_OPTION) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new LaunchArgsError(`${DATA_DIR_OPTION} にはパスが必要です`);
      }
      setDataDir(next);
      i += 1;
    } else if (arg.startsWith(`${DATA_DIR_OPTION}=`)) {
      setDataDir(arg.slice(DATA_DIR_OPTION.length + 1));
    } else {
      // オプション名だけを出す(値の部分は出さない)
      const name = arg.split('=')[0] ?? arg;
      throw new LaunchArgsError(`未知のオプションです: ${name}`);
    }
  }
  return { positional, dataDir };
}
