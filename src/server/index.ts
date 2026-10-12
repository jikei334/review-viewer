/**
 * サーバーの入口(`npm start` が実行する。SPEC §2.5)
 *
 * T1-0 時点では、サーバー本体(Hono、Host / Origin 検証、/healthz、シグナル処理)は
 * まだ実装されていない。T1-1 でここに実装が入る。
 * 起動したように見せかけないため、その旨を標準エラーへ出して、失敗として終了する。
 */

/** サーバーが未実装であることを伝えるメッセージ */
export const NOT_IMPLEMENTED_MESSAGE =
  'Review Viewer: サーバーはまだ実装されていません(PLAN.md の T1-1 で実装します)';

/**
 * サーバーを起動する(T1-0 時点では、未実装であることを伝えて失敗させる)
 *
 * @returns プロセスの終了コード(未実装のため、常に 1)
 */
export function main(): number {
  process.stderr.write(`${NOT_IMPLEMENTED_MESSAGE}\n`);
  return 1;
}

process.exitCode = main();
