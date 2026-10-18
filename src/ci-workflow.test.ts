/**
 * T1-7: CI のワークフロー(.github/workflows/ci.yml)を固定する単体テスト
 *
 * ワークフローは GitHub 上でしか実行されないので、手元で確かめられる範囲として、次の2つを主な検査にする。
 *  1. ワークフローの、コメントだけの行と空行を除いた**全行**が、このテストに書いた並び(EXPECTED_WORKFLOW_LINES)と
 *     完全に一致すること(字下げと、行末のコメントを含む)。行の追加・削除・変更・入れ替えは、すべてここで落ちる。
 *     ワークフローを変えるときは、このテストの期待値も同じコミットで変える(変更を、レビューの目に触れさせるため)
 *  2. `.github/` の配下にあるものが、`workflows/ci.yml` だけであること(別のワークフロー、複合アクション
 *     (`.github/actions/`)、Dependabot の設定などが置かれたら落ちる。置くときは、このテストの期待値を変える)
 *
 * そのほかの検査(トリガー、権限、SHA の形など)は、落ちたときに理由が分かるようにするための補助。
 * 行単位の単純な検査なので、単独では抜け道がある(継続行、フロー形式、引用符つきのキーなど)。
 * 抜け道を塞いでいるのは、上の 1 の完全一致の検査。
 *
 * 限界:
 *  - YAML のパーサーは依存に無いので、YAML として正しいこと、GitHub Actions のスキーマに合っていることは、
 *    このテストでは保証しない。期待値そのものが誤っていれば、誤ったまま固定される
 *  - 期待値(EXPECTED_WORKFLOW_LINES)とワークフローを同時に書き換える変更は、このテストでは止まらない。
 *    止めるのはレビュー(差分に、期待値の変更として現れる)
 *  - コメントだけの行と空行は比べない。YAML では、ブロック形式の文字列(`run: |` など)の中の `#` で始まる行は
 *    コメントではなく中身になるが、そう書くには `|` を含む行への変更が要り、それは完全一致の検査で落ちる
 *  - SHA が、コメントに書いた版のリリースと本当に対応しているかは、検査しない(ネットワークに出ない)
 *  - `.github/` の外にあって CI の動作を変えるもの(package.json の scripts、`.npmrc`、Vitest や ESLint の設定など)と、
 *    GitHub のリポジトリ側の設定(Actions の既定の権限、ブランチ保護、必須のチェック)は、このテストの対象外
 *  - 禁止している外部サービスのアクションやコマンドが無いことは、src/static-checks.test.ts が検査する
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB_DIR = resolve(ROOT_DIR, '.github');
const WORKFLOW_PATH = resolve(GITHUB_DIR, 'workflows/ci.yml');

/**
 * ワークフローの、コメントだけの行と空行を除いた全行(字下げと行末のコメントを含む)。
 *
 * **ここを変えるのは、ワークフローを意図して変えるときだけ。** アクションの版を上げるときは、
 * 公式のリリースで SHA を確かめて、SHA と行末のコメントの両方を、ワークフローとここの両方で書き換える。
 */
const EXPECTED_WORKFLOW_LINES: readonly string[] = [
  'name: CI',
  'on:',
  '  push:',
  '    branches:',
  '      - main',
  '      - develop',
  '  pull_request:',
  'permissions:',
  '  contents: read',
  'concurrency:',
  '  group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}',
  '  cancel-in-progress: true',
  'jobs:',
  '  test:',
  '    name: check と e2e',
  '    runs-on: ubuntu-26.04',
  '    timeout-minutes: 20',
  '    steps:',
  '      - name: チェックアウト',
  '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  '        with:',
  '          persist-credentials: false',
  '      - name: Node.js 22 系を用意',
  '        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
  '        with:',
  "          node-version: '22'",
  '          check-latest: true',
  '          cache: npm',
  '      - name: 依存をインストール(package-lock.json のとおり)',
  '        run: npm ci',
  '      - name: 型検査・Lint・単体テスト',
  '        run: npm run check',
  '      - name: Chromium と、その実行に必要な OS のパッケージを入手',
  '        run: npx playwright install --with-deps chromium',
  '      - name: システムテスト(ビルドを含む)',
  '        run: npm run e2e',
];

/** package.json のうち、このテストが参照する部分 */
interface PackageJson {
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * ワークフローのファイルを読み、コメントだけの行と空行を除いた行を、そのまま返す
 *
 * 字下げ、行末の空白、行末のコメント、CR(改行が CRLF の場合)は取り除かない(完全一致で比べるため)。
 *
 * @returns コメントだけの行(空白のあとに `#` で始まる行)と、空白だけの行を除いた全行
 * @throws ファイルが読めないとき(ワークフローが無い場合を含む)
 */
function readSignificantLines(): string[] {
  return readFileSync(WORKFLOW_PATH, 'utf8')
    .split('\n')
    .filter((line) => !/^[ \t]*(?:#.*)?$/.test(line));
}

/**
 * ディレクトリの配下にあるものを、再帰的にすべて列挙する(ファイル、ディレクトリ、シンボリックリンクなど)
 *
 * シンボリックリンクはたどらない(リンクそのものを1件として返す)。
 *
 * @param directory 列挙するディレクトリの絶対パス
 * @param prefix 結果に付ける、`/` 区切りの相対パスの接頭辞(再帰用。最初は空文字列)
 * @returns 配下のすべての項目の、`/` 区切りの相対パス(並べ替え済み)
 * @throws ディレクトリが読めないとき
 */
function listEntriesRecursively(directory: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${prefix}${entry.name}`;
    found.push(relativePath);
    if (entry.isDirectory()) found.push(...listEntriesRecursively(join(directory, entry.name), `${relativePath}/`));
  }
  return found.sort();
}

/**
 * ワークフローのファイルを読み、行に分ける
 *
 * @returns ファイルの全行(改行は含まない)
 * @throws ファイルが読めないとき(ワークフローが無い場合を含む)
 */
function readWorkflowLines(): string[] {
  return readFileSync(WORKFLOW_PATH, 'utf8').split(/\r?\n/);
}

/**
 * 行から、YAML のコメントを取り除く
 *
 * 行頭、または空白の直後の `#` から行末までをコメントとみなす。引用符の中の `#` は考慮しない
 * (このワークフローには、引用符の中に `#` を書く箇所が無い。`${{ }}` の式にも `#` は無い)。
 *
 * @param line 元の行
 * @returns コメントと行末の空白を取り除いた行
 */
function stripComment(line: string): string {
  return line.replace(/(^|\s)#.*$/, '').trimEnd();
}

/**
 * ワークフローの、コメントと空行を除いた行を返す(設定として効く部分だけ)
 *
 * @returns コメントを取り除いた、空でない行の一覧
 */
function readEffectiveLines(): string[] {
  return readWorkflowLines()
    .map(stripComment)
    .filter((line) => line.trim() !== '');
}

/**
 * 指定したキーの行の直後に続く、より深いインデントの行(そのキーの中身)を取り出す
 *
 * @param lines コメントを取り除いた行の一覧
 * @param keyLine 探す行(インデントを含めた完全一致。例: `permissions:`)
 * @returns キーの中身の行(前後の空白を取り除いたもの)。キーが無ければ undefined
 */
function readBlock(lines: readonly string[], keyLine: string): string[] | undefined {
  const start = lines.indexOf(keyLine);
  if (start === -1) return undefined;
  const indent = keyLine.length - keyLine.trimStart().length;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.length - line.trimStart().length <= indent) break;
    block.push(line.trim());
  }
  return block;
}

/**
 * `run:` に書かれたコマンドを、書かれた順に取り出す
 *
 * @param lines コメントを取り除いた行の一覧
 * @returns コマンドの一覧(1行で書かれたものだけ。複数行の `run: |` は、`|` がそのまま入る)
 */
function listRunCommands(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const matched = /^\s*(?:- )?run:\s*(.*)$/.exec(line);
    return matched?.[1] === undefined ? [] : [matched[1]];
  });
}

/**
 * `uses:` に書かれたアクションの指定を、行末のコメントつきで取り出す
 *
 * @returns アクションの指定(`名前@参照`)と、行末のコメント(無ければ空文字列)の一覧
 */
function listUsedActions(): { action: string; comment: string }[] {
  return readWorkflowLines().flatMap((line) => {
    const matched = /^\s*(?:- )?uses:\s*(\S+)\s*(?:#\s*(.*))?$/.exec(line);
    return matched?.[1] === undefined ? [] : [{ action: matched[1], comment: (matched[2] ?? '').trim() }];
  });
}

describe('T1-7: CI のワークフロー', () => {
  it('T1-7: コメントだけの行と空行を除いた全行が、期待する並びと完全に一致する(字下げと行末のコメントを含む)', () => {
    expect(readSignificantLines()).toEqual(EXPECTED_WORKFLOW_LINES);
  });

  it('T1-7: ワークフローが、UTF-8 の BOM、タブ、CR を含まない', () => {
    const text = readFileSync(WORKFLOW_PATH, 'utf8');
    expect(text.startsWith('\uFEFF')).toBe(false);
    expect(text).not.toMatch(/[\t\r]/);
  });

  it('T1-7: .github/ の配下にあるのは、workflows/ci.yml だけ(別のワークフローや複合アクションが無い)', () => {
    expect(listEntriesRecursively(GITHUB_DIR)).toEqual(['workflows', 'workflows/ci.yml']);
  });

  it('T1-7: playwright が、版を固定して devDependencies にあり、package-lock.json がある(npm ci と、ブラウザの入手の前提)', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8')) as PackageJson;
    // `npx playwright install` は、npm ci で入れた版の playwright が指定するブラウザを入れる。
    // 依存に無いと、npx がレジストリから最新の版を取ってきて実行してしまう
    expect(pkg.devDependencies?.playwright).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => readFileSync(resolve(ROOT_DIR, 'package-lock.json'), 'utf8')).not.toThrow();
  });

  describe('補助(落ちたときに理由を示す。行単位の検査で、網羅は上の完全一致の検査が担う)', () => {
    it('T1-7: main と develop への push、および pull_request で実行する', () => {
      const lines = readEffectiveLines();
      expect(readBlock(lines, 'on:')).toEqual(['push:', 'branches:', '- main', '- develop', 'pull_request:']);
    });

    it('T1-7: 外部のフォークのコードを、書き込み権限つきで動かすトリガー(pull_request_target、workflow_run)を使わない', () => {
      const text = readEffectiveLines().join('\n');
      expect(text).not.toMatch(/pull_request_target|workflow_run/);
    });

    it('T1-7: 権限は、リポジトリの読み取りだけ(ワークフロー全体。ジョブで広げていない)', () => {
      const lines = readEffectiveLines();
      expect(readBlock(lines, 'permissions:')).toEqual(['contents: read']);
      // permissions は、最上位の1か所だけ(ジョブの側で上書きしていない)
      expect(lines.filter((line) => /^\s*permissions:/.test(line))).toEqual(['permissions:']);
    });

    it('T1-7: 同じプルリクエストの古い実行を止める(push の実行は止めない)', () => {
      const lines = readEffectiveLines();
      expect(readBlock(lines, 'concurrency:')).toEqual([
        'group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}',
        'cancel-in-progress: true',
      ]);
    });

    it('T1-7: ランナーは版を固定した Ubuntu で、ジョブに時間の上限がある', () => {
      const lines = readEffectiveLines();
      const runners = lines.filter((line) => /^\s*runs-on:/.test(line)).map((line) => line.trim());
      const timeouts = lines.filter((line) => /^\s*timeout-minutes:/.test(line)).map((line) => line.trim());
      // ジョブは1つ。Playwright 1.64.0 が対応する Ubuntu(22.04 / 24.04 / 26.04)のうち、開発機と同じ版
      expect(runners).toEqual(['runs-on: ubuntu-26.04']);
      expect(timeouts).toHaveLength(runners.length);
      for (const timeout of timeouts) {
        const minutes = Number(timeout.replace('timeout-minutes:', '').trim());
        expect(Number.isInteger(minutes)).toBe(true);
        expect(minutes).toBeGreaterThan(0);
        expect(minutes).toBeLessThanOrEqual(30);
      }
    });

    it('T1-7: Node.js は 22 系で、package.json の engines が 22 系を含んでいる', () => {
      const lines = readEffectiveLines().map((line) => line.trim());
      expect(lines.filter((line) => line.startsWith('node-version'))).toEqual(["node-version: '22'"]);
      expect(lines).toContain('check-latest: true');
    expect(lines).toContain('cache: npm');
      const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8')) as PackageJson;
      // engines を変えたら、ワークフローの版も見直すこと
      expect(pkg.engines?.node).toMatch(/\^22\./);
    });

    it('T1-7: 手順は、npm ci → npm run check → Chromium の入手 → npm run e2e の順で、ほかのコマンドを実行しない', () => {
      expect(listRunCommands(readEffectiveLines())).toEqual([
        'npm ci',
        'npm run check',
        'npx playwright install --with-deps chromium',
        'npm run e2e',
      ]);
    });

    it('T1-7: ワークフローが呼ぶ npm scripts が、package.json にある', () => {
      const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8')) as PackageJson;
      expect(Object.keys(pkg.scripts ?? {})).toEqual(expect.arrayContaining(['check', 'e2e']));
    });

    it('T1-7: 失敗を無視する設定や、手順を条件で飛ばす設定が無い', () => {
      const lines = readEffectiveLines();
      const text = lines.join('\n');
      expect(text).not.toMatch(/continue-on-error/);
      expect(text).not.toMatch(/\|\|\s*true/);
      expect(text).not.toMatch(/fail-fast/);
      // `if:` で手順やジョブを飛ばしていない
      expect(lines.filter((line) => /^\s*(?:- )?if:/.test(line))).toEqual([]);
    });

    it('T1-7: 秘密と、アプリ・システムテストの環境変数を設定していない', () => {
      const lines = readEffectiveLines();
      const text = lines.join('\n');
      expect(text).not.toMatch(/secrets\s*\./);
      expect(text).not.toMatch(/REVIEW_VIEWER_|E2E_APP_DIR|E2E_SKIP_BUILD/);
      // env のブロック自体が無い(ワークフロー、ジョブ、手順のどこにも)
      expect(lines.filter((line) => /^\s*(?:- )?env:/.test(line))).toEqual([]);
    });

    it('T1-7: 使うアクションは GitHub 公式(actions/ の配下)だけで、コミットの SHA(40 桁)で固定し、版をコメントに書いている', () => {
      const used = listUsedActions();
      expect(used.map((entry) => entry.action.split('@')[0])).toEqual(['actions/checkout', 'actions/setup-node']);
      for (const entry of used) {
        expect(entry.action).toMatch(/^actions\/[a-z0-9-]+@[0-9a-f]{40}$/);
        expect(entry.comment).toMatch(/^v\d+\.\d+\.\d+$/);
      }
      // `uses:` の行を、上の取り出し方で取りこぼしていない
      const usesLineCount = readEffectiveLines().filter((line) => /\buses:/.test(line)).length;
      expect(used).toHaveLength(usesLineCount);
    });

    it('T1-7: チェックアウトのあとに、認証情報を残さない', () => {
      expect(readEffectiveLines().map((line) => line.trim())).toContain('persist-credentials: false');
    });

    it('T1-7: ブラウザをキャッシュしない(公式の推奨)。キャッシュは setup-node の npm だけ', () => {
      const text = readEffectiveLines().join('\n');
      expect(text).not.toMatch(/actions\/cache/);
      expect(text).not.toMatch(/ms-playwright|PLAYWRIGHT_BROWSERS_PATH/);
    });
  });
});
