/**
 * e2e 全体の前処理
 *
 * SPEC §2.5 の契約「`npm run build` の後に、`npm start` でサーバーが起動する」に従い、
 * テストの前に一度だけビルドする。古いビルド成果物に対してテストしてしまうのを防ぐ。
 *
 * 環境変数 `E2E_SKIP_BUILD=1` を指定すると、ビルドを省略する(ビルド済みを確認済みのとき用)。
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_DIR } from './helpers/server.js';

/**
 * コマンドを実行し、終了を待つ
 *
 * @param command 実行するコマンド
 * @param args 引数
 * @param cwd 実行するディレクトリ
 * @returns 終了コードと、標準出力・標準エラーを連結した文字列
 */
function run(
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, output }));
  });
}

/**
 * テスト対象やビルドを差し替える環境変数が設定されていたら、標準エラーへ目立つ警告を出す
 *
 * `E2E_APP_DIR` はテスト対象を、`E2E_SKIP_BUILD` はビルド成果物の新しさを変える。
 * 気づかないまま設定されていると、別のものをテストして「合格」と誤認するおそれがある。
 *
 * @returns なし
 */
function warnAboutOverrides(): void {
  const lines: string[] = [];
  if (process.env.E2E_APP_DIR) {
    lines.push(`E2E_APP_DIR が設定されています。テスト対象はリポジトリのルートではなく、次の場所です: ${APP_DIR}`);
  }
  if (process.env.E2E_SKIP_BUILD === '1') {
    lines.push(`E2E_SKIP_BUILD=1 が設定されています。npm run build を省略し、既存のビルド成果物(${APP_DIR})をそのまま使います`);
  }
  if (lines.length === 0) return;
  const bar = '!'.repeat(78);
  process.stderr.write(`\n${bar}\n[e2e 警告] 結果は、通常の手順(ビルドしたこのリポジトリ)に対するものではありません\n`);
  for (const line of lines) process.stderr.write(`[e2e 警告] ${line}\n`);
  process.stderr.write(`${bar}\n\n`);
}

/**
 * Vitest の globalSetup。アプリをビルドする
 * @returns なし(失敗したら例外を投げ、テスト全体を止める)
 */
export default async function setup(): Promise<void> {
  warnAboutOverrides();
  try {
    await access(join(APP_DIR, 'package.json'));
  } catch (err) {
    throw new Error(
      `${APP_DIR} に package.json がありません。実装がまだ無い場合、e2e は実行できません(赤で正常)。` +
        `原因: ${String(err)}`
    );
  }

  if (process.env.E2E_SKIP_BUILD === '1') return;

  const result = await run('npm', ['run', 'build'], APP_DIR);
  if (result.code !== 0) {
    throw new Error(`npm run build が失敗しました(終了コード ${result.code})。出力:\n${result.output}`);
  }
}
