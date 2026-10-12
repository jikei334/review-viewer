/**
 * T1-0、T1-N1、T1-P1: プロジェクト設定の単体テスト
 *
 * CLAUDE.md の「コマンド」節と SPEC §2.5 が固定している npm scripts の名前と、
 * Tester との取り決め(e2e の呼び出し方)が、package.json で守られていることを確認する。
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** このテストが参照する、package.json の一部 */
interface PackageJson {
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * package.json の、依存を書く欄(4 種類)をまとめて、パッケージ名の一覧にする
 *
 * @param pkg 解析済みの package.json
 * @returns すべての欄に書かれたパッケージ名(重複を含みうる)
 */
function listAllDependencyNames(pkg: PackageJson): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
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

/** このテストが参照する、tsconfig の一部 */
interface TsConfigJson {
  extends?: string;
  compilerOptions?: { lib?: string[] };
  include?: string[];
  exclude?: string[];
}

/**
 * リポジトリのルートにある tsconfig を読み込む(コメントつきの JSON なので、TypeScript の読み込み関数を使う)
 *
 * @param fileName ルートからのファイル名(例: tsconfig.json)
 * @returns 解析済みの tsconfig(extends 先は展開しない。そのファイルに書かれた内容だけ)
 * @throws 読み込みや解析に失敗したとき
 */
function readTsConfig(fileName: string): TsConfigJson {
  const result = ts.readConfigFile(resolve(ROOT_DIR, fileName), (path) => ts.sys.readFile(path));
  if (result.error !== undefined) {
    const message = ts.flattenDiagnosticMessageText(result.error.messageText, '\n');
    throw new Error(`${fileName} を読み込めません: ${message}`);
  }
  return result.config as TsConfigJson;
}

/**
 * lib の一覧に、DOM の型(DOM、DOM.Iterable など)が含まれるかを調べる
 *
 * @param lib tsconfig の compilerOptions.lib(未指定なら undefined)
 * @returns DOM の型が含まれていれば true
 */
function hasDomLib(lib: string[] | undefined): boolean {
  return (lib ?? []).some((name) => name.toLowerCase().startsWith('dom'));
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

  it('T1-N1: engines は Node.js 22.13 以上の 22 系と、24 以上だけを許す', async () => {
    const pkg = await readPackageJson();
    // 依存の対応範囲の共通部分に合わせる(eslint: ^20.19.0 || ^22.13.0 || >=24、
    // vite: ^20.19.0 || >=22.12.0、vitest: ^20 || ^22 || >=24、@hono/node-server: >=20)。
    // そこから、対象外にした Node.js 20 系を除く(Playwright の公式の動作要件が 22 / 24 / 26 のため)。
    // `>=22` だと、依存が対応しない 22.0〜22.12 や 23 系も許してしまう
    expect(pkg.engines?.node).toBe('^22.13.0 || >=24');
  });
});

describe('T1-P1: Playwright の依存', () => {
  it('T1-P1: playwright は devDependencies に、版を固定して入っている', async () => {
    const pkg = await readPackageJson();
    const version = pkg.devDependencies?.playwright;
    expect(version, 'devDependencies.playwright がありません').toBeTypeOf('string');
    // ブラウザ本体の版は playwright の版で決まるので、範囲指定(^ や ~ など)にしない。
    // 版がずれると、入手済みのブラウザの実行ファイルを見つけられなくなる
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('T1-P1: playwright は実行時の依存(dependencies など)に入っていない', async () => {
    const pkg = await readPackageJson();
    // システムテストでだけ使う。アプリの実行には要らない
    expect(pkg.dependencies ?? {}).not.toHaveProperty('playwright');
    expect(pkg.optionalDependencies ?? {}).not.toHaveProperty('playwright');
    expect(pkg.peerDependencies ?? {}).not.toHaveProperty('playwright');
  });

  it('T1-P1: @playwright/test(別のテストランナー)と playwright-core を直接の依存にしていない', async () => {
    const pkg = await readPackageJson();
    // システムテストのランナーは Vitest の1つだけにする(npm run e2e -- -t <基準 ID> の契約を保つため)
    const names = listAllDependencyNames(pkg);
    expect(names).not.toContain('@playwright/test');
    expect(names).not.toContain('playwright-core');
  });

  it('T1-P1、C-4: @anthropic-ai/* に依存していない', async () => {
    const pkg = await readPackageJson();
    const names = listAllDependencyNames(pkg);
    expect(names.filter((name) => name.startsWith('@anthropic-ai/'))).toEqual([]);
  });

  it('T1-P1: e2e の scripts は Playwright の導入後も変わらない(ランナーを足していない)', async () => {
    const pkg = await readPackageJson();
    expect(pkg.scripts?.e2e).toBe('vitest run --config e2e/vitest.config.ts');
    const all = Object.values(pkg.scripts ?? {}).join('\n');
    expect(all).not.toContain('playwright');
  });
});

describe('T1-P1: 型検査の設定(サーバー側に DOM の型を入れない)', () => {
  it('T1-P1: typecheck は、サーバー側・画面・e2e の3つの tsconfig を検査する', async () => {
    const pkg = await readPackageJson();
    expect(pkg.scripts?.typecheck).toBe(
      'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.client.json && tsc --noEmit -p tsconfig.e2e.json'
    );
  });

  it('T1-P1: サーバー側の tsconfig.json は、lib に DOM を含まない', () => {
    const config = readTsConfig('tsconfig.json');
    // lib を書かないと、target に応じて DOM が既定で入る。必ず明示する
    expect(config.compilerOptions?.lib, 'lib を明示してください').toBeInstanceOf(Array);
    expect(hasDomLib(config.compilerOptions?.lib)).toBe(false);
  });

  it('T1-P1: サーバーのビルド用の tsconfig.build.json は、lib を上書きしていない', () => {
    const config = readTsConfig('tsconfig.build.json');
    expect(config.extends).toBe('./tsconfig.json');
    expect(config.compilerOptions?.lib).toBeUndefined();
  });

  it('T1-P1: サーバー側の tsconfig.json は e2e/ を対象にしない(e2e 用の設定と二重に検査しない)', () => {
    const config = readTsConfig('tsconfig.json');
    expect((config.include ?? []).filter((pattern) => pattern.startsWith('e2e'))).toEqual([]);
    expect(config.exclude).toContain('e2e');
  });

  it('T1-P1: tsconfig.e2e.json は tsconfig.json を継承し、lib に DOM を足して、e2e/ を対象にする', () => {
    const config = readTsConfig('tsconfig.e2e.json');
    expect(config.extends).toBe('./tsconfig.json');
    // page.evaluate(() => document.title) のように、ブラウザの中で動く関数を型検査できるようにする
    expect(config.compilerOptions?.lib).toContain('DOM');
    expect(config.compilerOptions?.lib).toContain('ES2022');
    expect(config.include).toEqual(['e2e/**/*.ts']);
    // フィクスチャのリポジトリはテストデータなので、型検査の対象にしない
    expect(config.exclude).toContain('e2e/fixtures');
  });
});
