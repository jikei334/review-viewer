/**
 * 対象リポジトリの決定に使う、実際の入出力(ファイルシステムと端末)
 *
 * repo-dir.ts に注入するための薄い実装。ユーザー指定のファイルを読むものではなく、
 * 起動時の設定(対象リポジトリのパス)が存在するディレクトリかを確かめるだけ。
 */
import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolveBaseDir, resolveRepoDir, type PathKind } from './repo-dir.js';

/**
 * パスの種類を調べる(シンボリックリンクはたどる)
 *
 * @param path 調べるパス
 * @returns 判定結果。存在しなければ not_found、ENOENT/ENOTDIR 以外の失敗は unreadable
 */
export function inspectPath(path: string): PathKind {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'not_directory';
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'not_found';
    return 'unreadable';
  }
}

/**
 * 端末で1行の入力を求める
 *
 * Ctrl-C(SIGINT)や入力の終端(Ctrl-D)では undefined を返す。
 * 入力の待機中に SIGTERM が来たときは、index.ts のハンドラが終了する。
 *
 * @param question 表示する質問
 * @returns 入力された1行。中断されたときは undefined
 */
export function promptLine(question: string): Promise<string | undefined> {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let answered = false;
    rl.once('SIGINT', () => {
      rl.close();
    });
    rl.once('close', () => {
      if (!answered) resolvePrompt(undefined);
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolvePrompt(answer);
    });
  });
}

/**
 * 実際のプロセスの引数・環境変数・端末から、対象リポジトリを決める
 *
 * @returns 存在するディレクトリの絶対パス
 * @throws RepoDirError 決められなかったとき
 * @throws RepoDirCancelledError 入力が中断されたとき
 */
export function resolveRepoDirFromProcess(): Promise<string> {
  return resolveRepoDir({
    args: process.argv.slice(2),
    env: process.env,
    baseDir: resolveBaseDir(process.env, process.cwd()),
    inspect: inspectPath,
    isInteractive: process.stdin.isTTY,
    prompt: promptLine,
  });
}
