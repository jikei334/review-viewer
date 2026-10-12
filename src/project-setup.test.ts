/**
 * T1-0: プロジェクト設定の単体テスト
 *
 * CLAUDE.md の「コマンド」節と SPEC §2.5 が固定している npm scripts の名前と、
 * Tester との取り決め(e2e の呼び出し方)が、package.json で守られていることを確認する。
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** このテストが参照する、package.json の一部 */
interface PackageJson {
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
}

/**
 * リポジトリのルートにある package.json を読み込む
 *
 * @returns 解析済みの package.json
 */
async function readPackageJson(): Promise<PackageJson> {
  const text = await readFile(resolve(ROOT_DIR, 'package.json'), 'utf8');
  return JSON.parse(text) as PackageJson;
}

describe('T1-0: package.json', () => {
  it.each(['dev', 'build', 'test', 'typecheck', 'lint', 'check', 'start', 'e2e'])(
    'T1-0: npm script "%s" が定義されている',
    async (name) => {
      const pkg = await readPackageJson();
      expect(pkg.scripts?.[name], `scripts.${name} がありません`).toBeTypeOf('string');
      expect(pkg.scripts?.[name]).not.toBe('');
    }
  );

  it('T1-0: e2e は e2e/vitest.config.ts を使って実行する', async () => {
    const pkg = await readPackageJson();
    expect(pkg.scripts?.e2e).toBe('vitest run --config e2e/vitest.config.ts');
  });

  it('T1-0: check は typecheck、lint、test の順に実行する', async () => {
    const pkg = await readPackageJson();
    expect(pkg.scripts?.check).toBe('npm run typecheck && npm run lint && npm run test');
  });

  it('T1-0: scripts に E2E_APP_DIR / E2E_SKIP_BUILD を書いていない', async () => {
    const pkg = await readPackageJson();
    const all = Object.values(pkg.scripts ?? {}).join('\n');
    expect(all).not.toContain('E2E_APP_DIR');
    expect(all).not.toContain('E2E_SKIP_BUILD');
  });

  it('T1-0: engines は Node.js 20 系で動く指定になっている', async () => {
    const pkg = await readPackageJson();
    expect(pkg.engines?.node).toBe('>=20.19.0');
  });
});
