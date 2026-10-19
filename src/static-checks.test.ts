/**
 * T1-6: セキュリティの静的チェック(SPEC C-4、§1、§8、CLAUDE.md の絶対ルール1)
 *
 * 「依存関係とソースコードに、Anthropic のパッケージへの依存と、claude コマンドの起動が存在しない」ことを、
 * リポジトリ自身を走査して確かめる。機能追加のときに外さない回帰テスト。
 *
 * 検査の対象:
 *  - 依存: package.json の依存を書く欄すべてと、package-lock.json の全体(推移的な依存を含む)
 *  - コード: リポジトリのルート以下のすべてのファイル(下の「対象外」を除く)。
 *    src/、ルートの設定ファイル(*.config.ts など)、e2e/ のテストコード、
 *    将来足される Containerfile や CI のワークフローも、置いた時点で自動的に対象になる
 *  - package.json の scripts(シェルのコマンドとして検査する)
 *
 * 対象外(理由):
 *  - EXCLUDED_DIRECTORIES のディレクトリ(それぞれの理由は定義の箇所に書いた)
 *  - 拡張子が .md のファイル: 文書であって実行されない。SPEC.md や CLAUDE.md は、
 *    禁止事項の説明として、禁止している語そのものを含む
 *  - このテストファイル自身: 検出できることを確かめるための違反のサンプルを、文字列として含むため
 *  - 秘密ファイルの名前(.env*、*.pem、*.key、id_rsa*、credentials* など。アプリの判定 isSecretName と同じ)の
 *    ファイルと、その名前のディレクトリの配下のファイル: 中身を読まない(CLAUDE.md の絶対ルール8)。
 *    パスは結果に残し、テストで見えるようにしている。
 *    ただし、名前だけで「実行されるもの」と分かるファイル(コードの拡張子、シェルのコマンドを書く拡張子・ファイル名。
 *    credentials.ts、credentials/run.ts、.env.sh、credentials-check.yml など)は、検査の抜け道にならないように検査する
 *  - 画像・フォントなど、ALLOWED_BINARY_EXTENSIONS の拡張子のファイル: 文字列として検査できない。
 *    それ以外のバイナリ(NUL バイトを含むファイル)があれば、テストを落とす
 *  - 秘密ファイルの名前のシンボリックリンク(ディレクトリへのリンクを含む): たどらない
 *
 * 失敗メッセージに出すもの(CLAUDE.md の絶対ルール8):
 *  - ファイル名、行番号、規則、パターンに一致した部分(語)だけ。行や文字列リテラルの全体は出さない
 *    (一致した行に、トークンなどの秘密が一緒に書かれていることがあるため)
 *
 * 限界:
 *  - 静的な検査なので、意図的な難読化は見抜けない。うっかりの混入を止めることと、プロセスの起動を足すときに
 *    許可リストの変更として人間とレビューの目に触れさせることが目的。見抜けないものの例:
 *    文字列の連結で組み立てたコマンド名、worker_threads の eval、createRequire の戻り値を変数に入れてからの呼び出し、
 *    別名に入れた getBuiltinModule、ブラケット記法(process['binding'])、globalThis 経由
 *  - プロセスを起動する外部パッケージは無数にあるので、PROCESS_LAUNCH_PACKAGES は代表的なものだけ
 *  - Node.js 以外のランタイムの API(Bun.spawn、Deno.Command)は検査しない(実行環境は Node.js)
 *  - 構文木で検査するのは TypeScript / JavaScript だけ。ほかの言語(.py、.rs など)は、テキストとして
 *    Anthropic への参照と child_process だけを見る(その言語でのプロセスの起動は見ない)
 *  - claude コマンドを探すのは、シェルのコマンドを書くファイル(拡張子、ファイル名、先頭行の `#!` で判定)と、
 *    package.json の scripts と、コードの文字列だけ。.json などの設定に書かれたコマンドは見ない
 *  - claude コマンドの判定は、空白などで区切られた単語だけ。`claude>out.txt` のように記号が直後に続く書き方や、
 *    `claude-` で始まる別名のコマンドは見ない
 *  - 秘密ファイルの名前(または、その名前のディレクトリの配下)で、拡張子の無いスクリプト(credentials-rotate、.envrc など)は
 *    検査しない。先頭行の `#!` を見るには中身を読む必要があり、秘密ファイルの中身は読まない方針を優先している
 *  - 許可した拡張子(画像・フォント)のファイルは、中身がコードでも検査しない(拡張子の偽装は見抜けない)
 *  - src/ のコードには、claude を単語として含む文字列(接続手順の案内など)や、Anthropic のドキュメントの URL を
 *    書けない。必要になったら、この検査の方針を人間が見直す(ステージ3で扱いを決める)
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
// 秘密ファイルの名前の判定は、アプリ本体と同じものを使う。
// 注意: path-policy.ts の規則を変えるときは、この検査の走査対象(読まずに外すファイル)への影響を確認すること
import { isSecretName } from './server/path-policy.js';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** このテストファイル自身の、ルートからの相対パス(違反のサンプルを含むので、走査から外す) */
const SELF_FILE = toPosixPath(relative(ROOT_DIR, fileURLToPath(import.meta.url)));

/**
 * 走査しないディレクトリ(ルートからの相対パス)。ここに無いディレクトリは、すべて走査する
 */
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  // 外部のパッケージの中身。名前は package-lock.json の検査で見る。中身は、このアプリのコードではない
  'node_modules',
  // バージョン管理の内部データ
  '.git',
  // src/ から作られる生成物(.gitignore 済み)。元の src/ を検査している
  'dist',
  'coverage',
  // 実行時のデータとテストの出力(.gitignore 済み)
  'data',
  'test-results',
  'playwright-report',
  // システムテストのデータ(表示対象のサンプルのリポジトリ)。実行されるコードではなく、
  // 秘密ファイルに見えるファイルやシンボリックリンクを、テストのために含む
  'e2e/fixtures',
  'e2e/.tmp',
  // Claude Code(開発に使う外部のクライアント)の設定とエージェント定義。このアプリのコードではない
  '.claude',
  // エディタの設定(.gitignore 済み)
  '.idea',
  '.vscode',
]);

/** TypeScript の構文木で検査する拡張子 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** 文書として、走査から外す拡張子 */
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set(['.md']);

/**
 * バイナリとして、中身を読まずに走査から外す拡張子(画像とフォント)。
 * ここに無い拡張子のバイナリは、検査できないものとしてテストを落とす。.svg はテキストなので検査する
 */
const ALLOWED_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
]);

/**
 * Anthropic への参照とみなす文字列。
 * パッケージ名(スコープ)、API のホスト名、環境変数名(ANTHROPIC_API_KEY など)を、まとめて拾う
 */
const ANTHROPIC_REFERENCE_PATTERN = /anthropic|(?<![a-z0-9-])claude\.(?:ai|com)(?![a-z0-9-])/i;

/**
 * 依存のパッケージ名・版の指定・取得元の URL に、含まれてはいけない文字列。
 * スコープつきの公式パッケージのほか、別名(npm: での別名)、Git の URL、
 * 名前に claude を含む非公式のラッパーも拾うために、広く取っている
 */
const FORBIDDEN_DEPENDENCY_PATTERN = /anthropic|claude/i;

/**
 * 文字列の中で、claude がコマンド名として現れている箇所。
 * 小文字で、単語として独立しているものだけ(前が行頭・空白・引用符・パス区切りなど、後ろが行末・空白など)。
 * 秘密ファイルのパターン(.claude.json、.claude/credentials.json)や、文書名(CLAUDE.md)には一致しない
 */
const CLAUDE_COMMAND_PATTERN = /(?:^|[\s;&|(`'"=/\\])claude(?:\.exe|\.cmd)?(?=$|[\s;&|)`'"])/;

/** プロセスを起動できる、Node.js の組み込みモジュール(`node:` の接頭辞は外して比べる) */
const PROCESS_LAUNCH_BUILTINS: readonly string[] = ['child_process', 'cluster'];

/** プロセスを起動するための、代表的な外部パッケージ(網羅ではない) */
const PROCESS_LAUNCH_PACKAGES: readonly string[] = [
  'execa',
  'cross-spawn',
  'shelljs',
  'zx',
  'node-pty',
  'tinyexec',
  'nano-spawn',
  'foreground-child',
  '@npmcli/promise-spawn',
  'open',
];

/** プロセスの起動や、ネイティブコードの読み込みに使える、process の内部寄りの API */
const PROCESS_INTERNAL_APIS: ReadonlySet<string> = new Set(['binding', '_linkedBinding', 'dlopen', 'execve']);

/** 文字列リテラルでないモジュールの指定を見つけたときに、一致した部分として記録する固定の文字列 */
const NON_LITERAL_SPECIFIER = '(文字列リテラルでない指定)';

/** 検出した違反の種類 */
type Rule =
  | 'anthropic-reference' // Anthropic のパッケージ・ホスト名・環境変数名への参照
  | 'process-launch-module' // プロセスを起動するモジュールの読み込み
  | 'dynamic-module-specifier' // 読み込むモジュールが、文字列リテラルで書かれていない(静的に確かめられない)
  | 'process-internal-api' // process.binding など
  | 'claude-command'; // claude コマンドに見える文字列

/** 検出した違反の1件 */
interface Finding {
  /** ルートからの相対パス(package.json の scripts は `package.json#scripts.<名前>`) */
  file: string;
  /** 行番号(1 始まり) */
  line: number;
  rule: Rule;
  /** パターンに一致した部分(語)。失敗メッセージに出してよいのは、これだけ */
  match: string;
  /**
   * 許可リストとの突き合わせに使う文字列。コードでは、文字列リテラルや識別子の全体。それ以外では match と同じ。
   * **失敗メッセージに出さない**(リテラルに、秘密が一緒に書かれていることがあるため)
   */
  literal: string;
}

/** 許可リストの1件 */
interface AllowedFinding {
  file: string;
  rule: Rule;
  /** 文字列リテラルの全体(完全一致)。同じファイルの、別の文字列は許可しない */
  literal: string;
  /** 許可する理由 */
  reason: string;
  /** false のとき、該当する検出が無くてもよい(既定は true: 使われていない許可は、テストで落とす) */
  mustMatch?: boolean;
}

/**
 * 許可リスト。
 *
 * **ここに足すのは、人間とレビューの目に触れる変更にすること。**
 * src/ の実行コードがプロセスを起動する必要が出たら、理由を書いてここに足す(現状は 0 件)。
 */
const ALLOWED_FINDINGS: readonly AllowedFinding[] = [
  {
    file: 'e2e/helpers/server.ts',
    rule: 'process-launch-module',
    literal: 'node:child_process',
    reason: 'システムテストが、SPEC §2.5 の契約どおりに `npm start` でアプリを起動するため(Tester の領域)',
  },
  {
    file: 'e2e/global-setup.ts',
    rule: 'process-launch-module',
    literal: 'node:child_process',
    reason: 'システムテストの前に、SPEC §2.5 の契約どおりに `npm run build` を実行するため(Tester の領域)',
  },
  {
    file: 'e2e/startup.test.ts',
    rule: 'process-launch-module',
    literal: 'node:child_process',
    reason: 'システムテストが、SPEC §2.5 の契約どおりに `npm start -- <パス>` でアプリを起動し、終了コードを確かめるため(Tester の領域。T1-8)',
  },
  // 以下の2件は、T1-P1 で src/project-setup.test.ts に入った「依存に Anthropic のパッケージが無い」
  // テストの、題名と、比較に使う接頭辞。
  {
    file: 'src/project-setup.test.ts',
    rule: 'anthropic-reference',
    literal: 'T1-P1、C-4: @anthropic-ai/* に依存していない',
    reason: 'C-4 を確かめるテストの題名',
  },
  {
    file: 'src/project-setup.test.ts',
    rule: 'anthropic-reference',
    literal: '@anthropic-ai/',
    reason: 'C-4 を確かめるテストが、依存のパッケージ名と比べる接頭辞',
  },
];

/**
 * パスの区切りを `/` に揃える
 *
 * @param path OS の区切りで書かれた相対パス
 * @returns `/` 区切りの相対パス
 */
function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

/**
 * 長い文字列を、失敗メッセージ用に切り詰める
 *
 * @param text 元の文字列
 * @returns 200 文字までの文字列(超えた分は `…` に置き換える)
 */
function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * 値が、配列でないオブジェクトかどうかを調べる
 *
 * @param value 調べる値
 * @returns 配列でも null でもないオブジェクトなら true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON の値を再帰的にたどり、キーと文字列の値のうち、禁止のパターンに一致するものを集める
 *
 * @param value 解析済みの JSON の値
 * @param path 現在の位置(失敗メッセージ用。例: `packages.node_modules/x.resolved`)
 * @param ignoredKeys 中身を調べないキー(ハッシュ値など、偶然の一致が起こりうるもの)
 * @returns 一致した箇所の一覧(`位置: 文字列` の形)
 */
function findForbiddenStringsInJson(value: unknown, path: string, ignoredKeys: ReadonlySet<string>): string[] {
  if (typeof value === 'string') {
    return FORBIDDEN_DEPENDENCY_PATTERN.test(value) ? [`${path}: ${truncate(value)}`] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenStringsInJson(item, `${path}[${index}]`, ignoredKeys));
  }
  if (!isRecord(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (FORBIDDEN_DEPENDENCY_PATTERN.test(key)) found.push(`${childPath}: (キー) ${truncate(key)}`);
    if (ignoredKeys.has(key)) continue;
    found.push(...findForbiddenStringsInJson(child, childPath, ignoredKeys));
  }
  return found;
}

/**
 * package.json の、依存を書く欄すべてから、禁止の依存を探す
 *
 * 対象の欄: 名前に `dependencies` を含む欄すべて(dependencies、devDependencies、optionalDependencies、
 * peerDependencies、bundleDependencies、bundledDependencies、peerDependenciesMeta)と、
 * 版を差し替える欄(overrides、resolutions)。パッケージ名(キー)と、版の指定(値。別名や URL を含む)の両方を見る。
 *
 * @param packageJson 解析済みの package.json
 * @returns 違反の一覧(`位置: 文字列` の形)。無ければ空の配列
 * @throws package.json がオブジェクトでないとき
 */
function findForbiddenDependencies(packageJson: unknown): string[] {
  if (!isRecord(packageJson)) throw new Error('package.json の内容がオブジェクトではありません');
  const found: string[] = [];
  for (const [field, value] of Object.entries(packageJson)) {
    if (!/dependencies/i.test(field) && field !== 'overrides' && field !== 'resolutions') continue;
    found.push(...findForbiddenStringsInJson(value, field, new Set()));
  }
  return found;
}

/**
 * package-lock.json の全体から、禁止の依存を探す(推移的な依存を含む)
 *
 * パッケージの位置(`node_modules/...` のキー)、名前、依存の欄、取得元の URL などを、区別せずにすべて見る。
 * `integrity`(ハッシュ値)だけは、偶然の一致を避けるために見ない。
 *
 * @param lockJson 解析済みの package-lock.json
 * @returns 違反の一覧(`位置: 文字列` の形)。無ければ空の配列
 * @throws package-lock.json がオブジェクトでないとき
 */
function findForbiddenLockEntries(lockJson: unknown): string[] {
  if (!isRecord(lockJson)) throw new Error('package-lock.json の内容がオブジェクトではありません');
  return findForbiddenStringsInJson(lockJson, '', new Set(['integrity']));
}

/**
 * モジュールの指定が、プロセスを起動するモジュールを指しているかを調べる
 *
 * @param specifier import / require に書かれた文字列(例: `node:child_process`、`execa`)
 * @returns プロセスを起動するモジュール(または、その配下のパス)なら、そのモジュールの名前。違えば undefined
 */
function findProcessLaunchModule(specifier: string): string | undefined {
  const name = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return [...PROCESS_LAUNCH_BUILTINS, ...PROCESS_LAUNCH_PACKAGES].find(
    (launcher) => name === launcher || name.startsWith(`${launcher}/`)
  );
}

/**
 * 呼び出し式が、モジュールを読み込む呼び出し(`import()`、`require()`、`process.getBuiltinModule()`)かを調べる
 *
 * @param node 呼び出し式
 * @returns モジュールを読み込む呼び出しなら true
 */
function isModuleLoadCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee) && callee.text === 'require') return true;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'getBuiltinModule';
}

/**
 * 文字列リテラルが、モジュールの指定の位置(import / export ... from / require など)にあるかを調べる
 *
 * @param node 文字列リテラル(親ノードが設定されていること)
 * @returns モジュールの指定として書かれていれば true
 */
function isModuleSpecifierPosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return parent.moduleSpecifier === node;
  if (ts.isExternalModuleReference(parent)) return parent.expression === node;
  if (ts.isCallExpression(parent)) return isModuleLoadCall(parent) && parent.arguments[0] === node;
  // 型の位置の import('x')
  return ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent);
}

/**
 * 拡張子から、TypeScript の構文解析の種類を決める
 *
 * @param file ファイルのパス
 * @returns 構文解析の種類
 */
function scriptKindOf(file: string): ts.ScriptKind {
  switch (extname(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * TypeScript / JavaScript のコードを構文解析して、違反を探す(副作用なし)
 *
 * コメントは見ない(構文木に現れないため)。見るのは、文字列リテラル、テンプレートの文字列の部分、
 * JSX のテキスト、識別子、モジュールを読み込む呼び出し、process の内部寄りの API へのアクセス。
 *
 * @param file ファイルのパス(結果に入れる。拡張子で構文解析の種類を決める)
 * @param text ファイルの内容
 * @returns 検出した違反の一覧。無ければ空の配列
 */
function scanCode(file: string, text: string): Finding[] {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const findings: Finding[] = [];

  /**
   * 違反を1件記録する
   *
   * @param node 違反のあるノード(行番号を求める)
   * @param rule 違反の種類
   * @param match パターンに一致した部分(失敗メッセージに出す)
   * @param literal 文字列リテラルや識別子の全体(許可リストとの突き合わせ用。メッセージには出さない)
   * @returns なし
   */
  const report = (node: ts.Node, rule: Rule, match: string, literal: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ file, line: line + 1, rule, match, literal });
  };

  /**
   * ノードを検査して、子ノードへ進む
   *
   * @param node 検査するノード
   * @returns なし
   */
  const visit = (node: ts.Node): void => {
    const isStringPiece =
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);
    if (isStringPiece) {
      const value = node.text;
      const anthropic = ANTHROPIC_REFERENCE_PATTERN.exec(value);
      if (anthropic !== null) report(node, 'anthropic-reference', anthropic[0], value);
      if (CLAUDE_COMMAND_PATTERN.test(value)) report(node, 'claude-command', 'claude', value);
      // child_process は、どこに書かれていても拾う(createRequire 経由などの、読み込み方の違いに左右されないように)。
      // そのほかのモジュール名(cluster、open など)は普通の文字列としても現れるので、モジュールの指定の位置だけ
      const launcher = value.includes('child_process')
        ? 'child_process'
        : isModuleSpecifierPosition(node)
          ? findProcessLaunchModule(value)
          : undefined;
      if (launcher !== undefined) report(node, 'process-launch-module', launcher, value);
    } else if (ts.isIdentifier(node)) {
      const anthropic = ANTHROPIC_REFERENCE_PATTERN.exec(node.text);
      if (anthropic !== null) report(node, 'anthropic-reference', anthropic[0], node.text);
    }

    if (ts.isCallExpression(node) && isModuleLoadCall(node)) {
      const first = node.arguments[0];
      if (first !== undefined && !ts.isStringLiteralLike(first)) {
        // 引数の式は、メッセージに出さない(何が書かれているか分からないため)
        report(node, 'dynamic-module-specifier', NON_LITERAL_SPECIFIER, NON_LITERAL_SPECIFIER);
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      PROCESS_INTERNAL_APIS.has(node.name.text)
    ) {
      const api = `process.${node.name.text}`;
      report(node, 'process-internal-api', api, api);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

/**
 * ファイルが、シェルのコマンドを書くファイル(シェルスクリプト、CI のワークフロー、Containerfile など)かを調べる
 *
 * @param file ルートからの相対パス
 * @returns シェルのコマンドを書くファイルなら true
 */
function isShellLikeFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (['.sh', '.bash', '.zsh', '.yml', '.yaml'].includes(extname(base))) return true;
  return /^(Containerfile|Dockerfile|Makefile|justfile)/i.test(base);
}

/**
 * コード以外のテキストを、行ごとに検査する(副作用なし)
 *
 * すべてのテキストで、Anthropic への参照と `child_process` を探す。
 * シェルのコマンドとして扱う場合は、`#` のコメントを除いたうえで、claude コマンドも探す。
 * 結果には、パターンに一致した部分だけを入れる。行の内容は入れない(秘密が一緒に書かれていることがあるため)。
 *
 * @param file ファイルのパス(結果に入れる)
 * @param text ファイルの内容
 * @param shellLike シェルのコマンドとして扱うなら true
 * @returns 検出した違反の一覧。無ければ空の配列
 */
function scanText(file: string, text: string, shellLike: boolean): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = shellLike ? rawLine.replace(/(^|\s)#.*$/, '$1') : rawLine;
    /**
     * 違反を1件記録する
     *
     * @param rule 違反の種類
     * @param match パターンに一致した部分
     * @returns なし
     */
    const report = (rule: Rule, match: string): void => {
      findings.push({ file, line: index + 1, rule, match, literal: match });
    };
    const anthropic = ANTHROPIC_REFERENCE_PATTERN.exec(line);
    if (anthropic !== null) report('anthropic-reference', anthropic[0]);
    if (line.includes('child_process')) report('process-launch-module', 'child_process');
    if (shellLike && CLAUDE_COMMAND_PATTERN.test(line)) report('claude-command', 'claude');
  });
  return findings;
}

/**
 * package.json の scripts を、シェルのコマンドとして検査する
 *
 * @param scripts package.json の scripts の欄
 * @returns 検出した違反の一覧。無ければ空の配列
 * @throws scripts がオブジェクトでないとき、または値が文字列でないとき
 */
function scanNpmScripts(scripts: unknown): Finding[] {
  if (!isRecord(scripts)) throw new Error('package.json の scripts がオブジェクトではありません');
  return Object.entries(scripts).flatMap(([name, command]) => {
    if (typeof command !== 'string') throw new Error(`package.json の scripts.${name} が文字列ではありません`);
    return scanText(`package.json#scripts.${name}`, command, true);
  });
}

/**
 * 検出した違反を、許可リストと突き合わせる
 *
 * @param findings 検出した違反
 * @param allowlist 許可リスト
 * @returns violations: 許可されていない違反。unusedEntries: 該当する検出が無かった許可(mustMatch が false のものを除く)
 */
function applyAllowlist(
  findings: readonly Finding[],
  allowlist: readonly AllowedFinding[]
): { violations: Finding[]; unusedEntries: AllowedFinding[] } {
  /**
   * 許可の1件が、違反の1件に当てはまるかを調べる
   *
   * @param entry 許可
   * @param finding 違反
   * @returns ファイル・種類・文字列リテラルの全体が、すべて同じなら true
   */
  const matches = (entry: AllowedFinding, finding: Finding): boolean =>
    entry.file === finding.file && entry.rule === finding.rule && entry.literal === finding.literal;
  return {
    violations: findings.filter((finding) => !allowlist.some((entry) => matches(entry, finding))),
    unusedEntries: allowlist.filter(
      (entry) => entry.mustMatch !== false && !findings.some((finding) => matches(entry, finding))
    ),
  };
}

/**
 * 違反を、失敗メッセージ用の1行にする
 *
 * @param finding 違反
 * @returns `ファイル:行 [種類] 一致した部分` の形の文字列(literal は入れない)
 */
function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line} [${finding.rule}] ${finding.match}`;
}

/** ファイルを列挙した結果 */
interface FileListing {
  /** 走査の対象になるファイル(ルートからの相対パス、`/` 区切り、昇順) */
  files: string[];
  /** 秘密ファイルの名前(または、その名前のディレクトリの配下)なので、中身を読まずに外したパス(昇順) */
  secretPaths: string[];
}

/**
 * ファイルが、名前だけで「実行されるもの」と分かるかを調べる(中身は読まない)
 *
 * @param relativePath ルートからの相対パス
 * @returns コードの拡張子か、シェルのコマンドを書く拡張子・ファイル名なら true
 */
function isExecutableByName(relativePath: string): boolean {
  return CODE_EXTENSIONS.has(extname(relativePath).toLowerCase()) || isShellLikeFile(relativePath);
}

/**
 * ルート以下の、走査の対象になるファイルを列挙する
 *
 * 対象外の判定(EXCLUDED_DIRECTORIES)を、種類の判定より先に行う。対象外のものは、シンボリックリンクでも、たどらずに飛ばす。
 * 秘密ファイルの名前のディレクトリには進むが、その配下と、秘密ファイルの名前のファイルは、
 * 名前だけで実行されるものと分かるファイル(isExecutableByName)だけを対象にし、残りは読まずに secretPaths に入れる。
 * 秘密ファイルの名前のシンボリックリンク(と、その名前のディレクトリの配下のリンク)は、たどらずに secretPaths に入れる。
 *
 * @param rootDir 走査するルート(絶対パス)
 * @returns 対象のファイルと、秘密ファイルの名前で外したパス
 * @throws ディレクトリを読めないとき。または、対象外でも秘密ファイルの名前でもないのに、通常のファイルでも
 *   ディレクトリでもないもの(シンボリックリンクなど)があるとき(検査できないものを、黙って飛ばさないため)
 */
function listFiles(rootDir: string): FileListing {
  const listing: FileListing = { files: [], secretPaths: [] };
  /**
   * 1つのディレクトリを読み、ファイルを集めて、子のディレクトリへ進む
   *
   * @param relativeDir ルートからの相対パス(ルート自身は空文字列)
   * @param insideSecretDirectory 秘密ファイルの名前のディレクトリの配下なら true
   * @returns なし
   */
  const walk = (relativeDir: string, insideSecretDirectory: boolean): void => {
    for (const entry of readdirSync(resolve(rootDir, relativeDir), { withFileTypes: true })) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (EXCLUDED_DIRECTORIES.has(relativePath)) continue;
      const secret = insideSecretDirectory || isSecretName(entry.name);
      if (entry.isDirectory()) {
        walk(relativePath, secret);
      } else if (entry.isFile()) {
        // 秘密ファイルの名前でも、実行されるもの(credentials.ts、.env.sh など)は検査する(検査の抜け道にしない)
        if (secret && !isExecutableByName(relativePath)) listing.secretPaths.push(relativePath);
        else listing.files.push(relativePath);
      } else if (secret) {
        listing.secretPaths.push(relativePath);
      } else {
        throw new Error(`検査できない種類のファイルがあります(シンボリックリンクなど): ${relativePath}`);
      }
    }
  };
  walk('', false);
  listing.files.sort();
  listing.secretPaths.sort();
  return listing;
}

/** リポジトリを走査した結果 */
interface RepoScan {
  /** 構文木で検査したファイル */
  codeFiles: string[];
  /** 行ごとに検査した、コード以外のテキストのファイル */
  textFiles: string[];
  /** 文書として対象外にしたファイル */
  documentFiles: string[];
  /** 秘密ファイルの名前(または、その名前のディレクトリの配下)なので、中身を読まずに対象外にしたパス */
  secretPaths: string[];
  /** 許可した拡張子(画像・フォント)なので、中身を読まずに対象外にしたファイル */
  binaryFiles: string[];
  /** 許可した拡張子ではないのに、バイナリ(NUL バイトを含む)だったファイル。検査できていない */
  unexpectedBinaryFiles: string[];
  /** 検出した違反(許可リストを適用する前) */
  findings: Finding[];
}

/**
 * ルート以下を走査して、すべてのファイルを検査する
 *
 * @param rootDir 走査するルート(絶対パス)
 * @returns 検査したファイルの内訳と、検出した違反
 * @throws ファイルやディレクトリを読めないとき
 */
function scanRepository(rootDir: string): RepoScan {
  const listing = listFiles(rootDir);
  const scan: RepoScan = {
    codeFiles: [],
    textFiles: [],
    documentFiles: [],
    secretPaths: listing.secretPaths,
    binaryFiles: [],
    unexpectedBinaryFiles: [],
    findings: [],
  };
  for (const file of listing.files) {
    if (file === SELF_FILE) continue;
    const extension = extname(file).toLowerCase();
    if (DOCUMENT_EXTENSIONS.has(extension)) {
      scan.documentFiles.push(file);
      continue;
    }
    if (ALLOWED_BINARY_EXTENSIONS.has(extension)) {
      scan.binaryFiles.push(file);
      continue;
    }
    const content = readFileSync(resolve(rootDir, file));
    if (content.includes(0)) {
      scan.unexpectedBinaryFiles.push(file);
      continue;
    }
    const text = content.toString('utf8');
    if (CODE_EXTENSIONS.has(extension)) {
      scan.codeFiles.push(file);
      scan.findings.push(...scanCode(file, text));
    } else {
      scan.textFiles.push(file);
      // 拡張子の無いスクリプト(.husky/ のフックなど)は、先頭行の `#!` でシェル扱いにする
      scan.findings.push(...scanText(file, text, isShellLikeFile(file) || text.startsWith('#!')));
    }
  }
  return scan;
}

/**
 * ルートにある JSON のファイルを読み込む
 *
 * @param fileName ルートからのファイル名
 * @returns 解析済みの JSON
 * @throws 読み込みや解析に失敗したとき
 */
function readJson(fileName: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT_DIR, fileName), 'utf8')) as unknown;
}

describe('C-4: 依存に Anthropic のパッケージが無い', () => {
  it('C-4: package.json の、依存を書く欄のどれにも無い', () => {
    const packageJson = readJson('package.json');
    // 何も調べていないのに緑、にならないように、依存の欄が読めていることを確かめる
    expect(isRecord(packageJson) && isRecord(packageJson.dependencies)).toBe(true);
    expect(findForbiddenDependencies(packageJson)).toEqual([]);
  });

  it('C-4: package-lock.json の全パッケージ(推移的な依存を含む)に無い', () => {
    const lockJson = readJson('package-lock.json');
    // 何も調べていないのに緑、にならないように、パッケージの一覧が読めていることを確かめる
    const packages = isRecord(lockJson) && isRecord(lockJson.packages) ? Object.keys(lockJson.packages) : [];
    expect(packages).toContain('node_modules/hono');
    expect(packages.length).toBeGreaterThan(50);
    expect(findForbiddenLockEntries(lockJson)).toEqual([]);
  });

  it.each([
    ['dependencies', { dependencies: { '@anthropic-ai/sdk': '1.0.0' } }],
    ['devDependencies', { devDependencies: { '@anthropic-ai/claude-code': '^2.0.0' } }],
    ['optionalDependencies', { optionalDependencies: { '@anthropic-ai/sdk': '1.0.0' } }],
    ['peerDependencies', { peerDependencies: { '@anthropic-ai/sdk': '*' } }],
    ['bundleDependencies(配列)', { bundleDependencies: ['@anthropic-ai/sdk'] }],
    ['overrides(入れ子)', { overrides: { hono: { '@anthropic-ai/sdk': '1.0.0' } } }],
    ['別名(値の側に書かれる)', { dependencies: { ai: 'npm:@anthropic-ai/sdk@1.0.0' } }],
    ['Git の URL', { dependencies: { sdk: 'github:anthropics/anthropic-sdk-typescript' } }],
    ['大文字が混ざった名前', { dependencies: { '@Anthropic-AI/sdk': '1.0.0' } }],
    ['名前に claude を含む非公式のパッケージ', { dependencies: { 'claude-cli-wrapper': '1.0.0' } }],
  ])('C-4: 検出関数は package.json の違反を見つける: %s', (_label, packageJson) => {
    expect(findForbiddenDependencies(packageJson)).not.toEqual([]);
  });

  it('C-4: 検出関数は、違反のない package.json と、依存以外の欄の語では反応しない', () => {
    const packageJson = {
      name: 'review-viewer',
      description: 'Claude や Anthropic を呼び出さない、ローカルのツール',
      scripts: { test: 'vitest run' },
      dependencies: { hono: '4.13.13', '@hono/node-server': '2.1.4' },
      devDependencies: { vitest: '4.1.11' },
    };
    expect(findForbiddenDependencies(packageJson)).toEqual([]);
  });

  it.each([
    [
      '直接の依存',
      { packages: { 'node_modules/@anthropic-ai/sdk': { version: '1.0.0' } } },
      'packages.node_modules/@anthropic-ai/sdk: (キー) node_modules/@anthropic-ai/sdk',
    ],
    [
      '入れ子の node_modules',
      { packages: { 'node_modules/x/node_modules/@anthropic-ai/sdk': { version: '1.0.0' } } },
      'packages.node_modules/x/node_modules/@anthropic-ai/sdk: (キー) node_modules/x/node_modules/@anthropic-ai/sdk',
    ],
    [
      '別のパッケージの依存の欄(推移的な依存)',
      { packages: { 'node_modules/x': { version: '1.0.0', dependencies: { '@anthropic-ai/sdk': '^1.0.0' } } } },
      'packages.node_modules/x.dependencies.@anthropic-ai/sdk: (キー) @anthropic-ai/sdk',
    ],
    [
      '別名で入れたパッケージ(取得元の URL)',
      { packages: { 'node_modules/ai': { resolved: 'https://registry.npmjs.org/@anthropic-ai/sdk/-/sdk-1.0.0.tgz' } } },
      'packages.node_modules/ai.resolved: https://registry.npmjs.org/@anthropic-ai/sdk/-/sdk-1.0.0.tgz',
    ],
  ])('C-4: 検出関数は package-lock.json の違反を見つける: %s', (_label, lockJson, expected) => {
    expect(findForbiddenLockEntries(lockJson)).toContain(expected);
  });

  it('C-4: 検出関数は、違反のない package-lock.json と、integrity の値では反応しない', () => {
    const lockJson = {
      name: 'review-viewer',
      lockfileVersion: 3,
      packages: {
        '': { name: 'review-viewer', dependencies: { hono: '4.13.13' } },
        'node_modules/hono': {
          version: '4.13.13',
          resolved: 'https://registry.npmjs.org/hono/-/hono-4.13.13.tgz',
          integrity: 'sha512-anthropicCLAUDE==',
          license: 'MIT',
        },
      },
    };
    expect(findForbiddenLockEntries(lockJson)).toEqual([]);
  });

  it('C-4: 検出関数は、オブジェクトでない入力を、違反なしとして扱わずにエラーにする', () => {
    expect(() => findForbiddenDependencies(null)).toThrow();
    expect(() => findForbiddenLockEntries([])).toThrow();
  });
});

describe('C-4: ソースコードに、Anthropic への参照と、プロセスの起動が無い', () => {
  let scan: RepoScan;
  let violations: Finding[];
  let unusedEntries: AllowedFinding[];

  // 走査に失敗したとき(検査できない種類のファイルがある、など)に落ちるのを、この describe のテストだけにする。
  // 依存の検査と、検出関数の単体テストは、走査に失敗しても実行される
  beforeAll(() => {
    scan = scanRepository(ROOT_DIR);
    ({ violations, unusedEntries } = applyAllowlist(scan.findings, ALLOWED_FINDINGS));
  });

  it('C-4: 走査が、サーバー・設定・システムテストのコードを実際に読んでいる', () => {
    // 何も走査していないのに緑、にならないように、対象に入っているはずのファイルの名指しと、件数の下限で確かめる
    expect(scan.codeFiles).toEqual(expect.arrayContaining(['src/server/index.ts', 'vitest.config.ts', 'e2e/helpers/server.ts']));
    expect(scan.textFiles).toEqual(expect.arrayContaining(['package.json', 'package-lock.json']));
    expect(scan.codeFiles.filter((file) => file.startsWith('src/')).length).toBeGreaterThanOrEqual(10);
    expect(scan.codeFiles.filter((file) => file.startsWith('e2e/')).length).toBeGreaterThanOrEqual(3);
    // 対象外にしたものが、走査に紛れ込んでいないこと
    const scanned = [...scan.codeFiles, ...scan.textFiles];
    expect(scanned).not.toContain(SELF_FILE);
    expect(scanned.filter((file) => /^(node_modules|dist|\.git|\.claude|e2e\/fixtures)\//.test(file))).toEqual([]);
    expect(scanned.filter((file) => file.endsWith('.md'))).toEqual([]);
  });

  it('C-4: 対象外にしているのは、このテストファイル自身・文書・秘密ファイルの名前・画像とフォントだけ', () => {
    expect(SELF_FILE).toBe('src/static-checks.test.ts');
    expect(scan.documentFiles.filter((file) => !file.endsWith('.md'))).toEqual([]);
    // 秘密ファイルの名前で外したものに、コードやシェル系のファイルが入っていないこと(パスだけを出す。中身は読んでいない)
    expect(scan.secretPaths.filter(isExecutableByName)).toEqual([]);
    expect(scan.binaryFiles.filter((file) => !ALLOWED_BINARY_EXTENSIONS.has(extname(file).toLowerCase()))).toEqual([]);
    // 許可した拡張子でないバイナリは、検査できていないので落とす(置くなら、拡張子を許可に足すかを判断する)
    expect(scan.unexpectedBinaryFiles).toEqual([]);
  });

  it('C-4: リポジトリ全体に、許可されていない違反が無い', () => {
    expect(violations.map(formatFinding)).toEqual([]);
  });

  it('C-4: src/ には、許可つきのものも含めて、プロセスを起動するコードが1件も無い', () => {
    const launchRules: readonly Rule[] = ['process-launch-module', 'dynamic-module-specifier', 'process-internal-api', 'claude-command'];
    const inSrc = scan.findings.filter((finding) => finding.file.startsWith('src/') && launchRules.includes(finding.rule));
    expect(inSrc.map(formatFinding)).toEqual([]);
    expect(ALLOWED_FINDINGS.filter((entry) => entry.file.startsWith('src/') && launchRules.includes(entry.rule))).toEqual([]);
  });

  it('C-4: 許可リストに、使われていない許可が残っていない(実在のコードで検出が働いていることの確認を兼ねる)', () => {
    // e2e/ の2ファイルは、実際に node:child_process を読み込んでいる。ここが空でなくなるのは、
    // その読み込みが消えたときか、検出が働かなくなったとき
    expect(unusedEntries).toEqual([]);
    expect(scan.findings.map(formatFinding)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^e2e\/helpers\/server\.ts:\d+ \[process-launch-module\] child_process$/)])
    );
  });

  it('C-4: package.json の scripts に、Anthropic への参照と claude コマンドが無い', () => {
    const packageJson = readJson('package.json');
    const scripts = isRecord(packageJson) ? packageJson.scripts : undefined;
    expect(isRecord(scripts) && Object.keys(scripts)).toEqual(expect.arrayContaining(['build', 'start', 'check']));
    expect(scanNpmScripts(scripts).map(formatFinding)).toEqual([]);
  });
});

describe('C-4: 走査(listFiles、scanRepository)を、一時ディレクトリのツリーで確かめる', () => {
  /** 明らかなダミーの値。秘密の代わりに書いて、失敗メッセージに出ないことを確かめる */
  const DUMMY_SECRET = 'DUMMY-VALUE-NOT-A-REAL-KEY';
  const tempDirs: string[] = [];

  /**
   * OS の一時ディレクトリに、指定した内容のツリーを作る(テストの後で消す)
   *
   * @param files 相対パス(`/` 区切り)から、内容への対応
   * @returns 作ったツリーのルート(絶対パス)
   */
  const makeTree = (files: Record<string, string | Buffer>): string => {
    const root = mkdtempSync(join(tmpdir(), 'review-viewer-static-checks-'));
    tempDirs.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('C-4、ルール8: 秘密ファイルの名前のファイルは読まず、名前だけを結果に残す', () => {
    const root = makeTree({
      '.env': `ANTHROPIC_API_KEY=${DUMMY_SECRET}\n`,
      '.env.local': `ANTHROPIC_API_KEY=${DUMMY_SECRET}\n`,
      '.env.example': 'ANTHROPIC_API_KEY=\n',
      'certs/server.pem': `anthropic ${DUMMY_SECRET}\n`,
      'certs/server.key': `anthropic ${DUMMY_SECRET}\n`,
      'id_rsa': `anthropic ${DUMMY_SECRET}\n`,
      'credentials.json': `{"anthropic": "${DUMMY_SECRET}"}\n`,
      '.claude.json': `{"anthropic": "${DUMMY_SECRET}"}\n`,
      '.ssh/config': `anthropic ${DUMMY_SECRET}\n`,
      'src/a.ts': 'export const a = 1;\n',
    });
    const scan = scanRepository(root);
    expect(scan.secretPaths).toEqual([
      '.claude.json',
      '.env',
      '.env.example',
      '.env.local',
      '.ssh/config',
      'certs/server.key',
      'certs/server.pem',
      'credentials.json',
      'id_rsa',
    ]);
    expect(scan.codeFiles).toEqual(['src/a.ts']);
    expect(scan.textFiles).toEqual([]);
    expect(scan.findings).toEqual([]);
  });

  it('C-4、ルール8: 秘密ファイル以外でも、一致した行や文字列の内容を、失敗メッセージに出さない', () => {
    const root = makeTree({
      'notes.txt': `メモ\nANTHROPIC_API_KEY=${DUMMY_SECRET}\n`,
      'deploy.sh': `#!/bin/sh\nclaude -p "${DUMMY_SECRET}"\n`,
      'src/a.ts': `export const call = () => fetch('https://api.anthropic.com/v1?key=${DUMMY_SECRET}');\n`,
      'src/b.ts': `export const load = () => import(\`./\${'${DUMMY_SECRET}'}\`);\n`,
    });
    const messages = applyAllowlist(scanRepository(root).findings, []).violations.map(formatFinding);
    expect(messages).toEqual([
      'deploy.sh:2 [claude-command] claude',
      'notes.txt:2 [anthropic-reference] ANTHROPIC',
      'src/a.ts:1 [anthropic-reference] anthropic',
      `src/b.ts:1 [dynamic-module-specifier] ${NON_LITERAL_SPECIFIER}`,
    ]);
    expect(messages.join('\n')).not.toContain(DUMMY_SECRET);
  });

  it('C-4: 秘密ファイルの名前でも、コードのファイルは検査する(検査の抜け道にしない)', () => {
    const root = makeTree({ 'src/credentials.ts': `import { spawn } from 'node:child_process';\nexport const s = spawn;\n` });
    const scan = scanRepository(root);
    expect(scan.secretPaths).toEqual([]);
    expect(scan.findings.map(formatFinding)).toEqual(['src/credentials.ts:1 [process-launch-module] child_process']);
  });

  it('C-4: 秘密ファイルの名前のディレクトリの配下でも、コードとシェル系のファイルは検査する(検査の抜け道にしない)', () => {
    const root = makeTree({
      'src/server/credentials/run.ts': `import { spawn } from 'node:child_process';\nexport const run = () => spawn('claude');\n`,
      'src/.aws/x.ts': `import '@anthropic-ai/sdk';\n`,
      'src/.environment/x.ts': `import '@anthropic-ai/sdk';\n`,
      'src/.ssh/nested/deep/y.mjs': `import 'execa';\n`,
      'scripts/credentials.sh': 'claude -p fix\n',
      'scripts/id_rsa.sh': 'npx @anthropic-ai/claude-code\n',
      '.env.sh': 'claude -p fix\n',
      '.github/workflows/credentials-check.yml': '      - uses: anthropics/claude-code-action@v1\n',
      'credentials/Containerfile': 'RUN claude -p fix\n',
      // 同じディレクトリの、実行されるものでないファイルは、読まない
      'src/server/credentials/token.txt': `anthropic ${DUMMY_SECRET}\n`,
      'src/.aws/config': `anthropic ${DUMMY_SECRET}\n`,
    });
    const scan = scanRepository(root);
    expect(scan.findings.map(formatFinding)).toEqual([
      '.env.sh:1 [claude-command] claude',
      '.github/workflows/credentials-check.yml:1 [anthropic-reference] anthropic',
      'credentials/Containerfile:1 [claude-command] claude',
      'scripts/credentials.sh:1 [claude-command] claude',
      'scripts/id_rsa.sh:1 [anthropic-reference] anthropic',
      'src/.aws/x.ts:1 [anthropic-reference] anthropic',
      'src/.environment/x.ts:1 [anthropic-reference] anthropic',
      'src/.ssh/nested/deep/y.mjs:1 [process-launch-module] execa',
      'src/server/credentials/run.ts:1 [process-launch-module] child_process',
      'src/server/credentials/run.ts:2 [claude-command] claude',
    ]);
    expect(scan.secretPaths).toEqual(['src/.aws/config', 'src/server/credentials/token.txt']);
  });

  it('C-4(限界): 秘密ファイルの名前で、拡張子の無いスクリプトは、読まないので検査されない(パスは結果に残る)', () => {
    const root = makeTree({
      'scripts/credentials-rotate': '#!/bin/sh\nclaude -p fix\n',
      '.envrc': 'claude -p fix\n',
    });
    const scan = scanRepository(root);
    expect(scan.findings).toEqual([]);
    expect(scan.secretPaths).toEqual(['.envrc', 'scripts/credentials-rotate']);
  });

  it('C-4: 秘密ファイルの名前のシンボリックリンクは、ディレクトリへのリンクでも、配下のリンクでも、たどらない', () => {
    const root = makeTree({
      'outside/run.ts': `import 'node:child_process';\n`,
      'src/credentials/a.ts': 'export const a = 1;\n',
    });
    symlinkSync(join(root, 'outside'), join(root, 'src/.aws'));
    symlinkSync(join(root, 'outside/run.ts'), join(root, 'src/credentials/link.ts'));
    expect(listFiles(root)).toEqual({
      files: ['outside/run.ts', 'src/credentials/a.ts'],
      secretPaths: ['src/.aws', 'src/credentials/link.ts'],
    });
  });

  it('C-4: 対象外のパスは、シンボリックリンクでも、たどらずに飛ばす(例外にしない)', () => {
    const root = makeTree({ 'src/a.ts': 'export const a = 1;\n', 'outside/pkg/index.js': 'x', 'outside/secret.txt': DUMMY_SECRET });
    // node_modules と data がリンク、gitignore 済みの .env.local がリンク、という配置
    symlinkSync(join(root, 'outside/pkg'), join(root, 'node_modules'));
    symlinkSync(join(root, 'outside/pkg'), join(root, 'data'));
    symlinkSync(join(root, 'outside/secret.txt'), join(root, '.env.local'));
    expect(listFiles(root)).toEqual({
      files: ['outside/pkg/index.js', 'outside/secret.txt', 'src/a.ts'],
      secretPaths: ['.env.local'],
    });
  });

  it('C-4: 対象外でないシンボリックリンクは、黙って飛ばさずにエラーにする', () => {
    const root = makeTree({ 'src/a.ts': 'export const a = 1;\n' });
    symlinkSync(join(root, 'src/a.ts'), join(root, 'src/link.ts'));
    expect(() => listFiles(root)).toThrow('検査できない種類のファイルがあります(シンボリックリンクなど): src/link.ts');
  });

  it('C-4: 先頭行が #! のファイルは、拡張子が無くてもシェルのコマンドとして検査する', () => {
    const root = makeTree({
      '.husky/pre-commit': '#!/usr/bin/env sh\n# claude は使わない\nclaude -p "review"\n',
      'bin/notes': 'claude -p "これはシェルではないテキスト"\n',
    });
    expect(scanRepository(root).findings.map(formatFinding)).toEqual(['.husky/pre-commit:3 [claude-command] claude']);
  });

  it('C-4: 画像とフォントは読まずに外し、それ以外のバイナリは、検査できないものとして分けて返す', () => {
    const root = makeTree({
      'src/client/favicon.ico': Buffer.from([0, 1, 2]),
      'reports/shot.PNG': Buffer.from([0, 1, 2]),
      'src/client/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
      'tools/blob.bin': Buffer.from([0x61, 0, 0x62]),
    });
    const scan = scanRepository(root);
    expect(scan.binaryFiles).toEqual(['reports/shot.PNG', 'src/client/favicon.ico']);
    expect(scan.unexpectedBinaryFiles).toEqual(['tools/blob.bin']);
    expect(scan.textFiles).toEqual(['src/client/icon.svg']);
  });
});

describe('C-4: コードの検出関数(scanCode)', () => {
  /**
   * サンプルのコードを検査して、検出した違反の種類だけを返す
   *
   * @param code TypeScript のコード
   * @param file ファイル名(既定は sample.ts)
   * @returns 違反の種類の一覧(検出した順)
   */
  const rulesOf = (code: string, file = 'sample.ts'): Rule[] => scanCode(file, code).map((finding) => finding.rule);

  it.each([
    ['import 文', `import Anthropic from '@anthropic-ai/sdk';`],
    ['副作用だけの import', `import '@anthropic-ai/sdk';`],
    ['型だけの import', `import type { Message } from '@anthropic-ai/sdk';`],
    ['export ... from', `export * from '@anthropic-ai/sdk';`],
    ['動的 import', `const sdk = await import('@anthropic-ai/sdk');`],
    ['require', `const sdk = require('@anthropic-ai/claude-agent-sdk');`],
    ['API のホスト名', `await fetch('https://api.anthropic.com/v1/messages');`],
    ['テンプレートの中のホスト名', 'const url = `https://api.anthropic.com/v1/${path}`;'],
    ['別のホスト名', `const url = 'https://claude.ai/api/organizations';`],
    ['環境変数(プロパティ)', `const key = process.env.ANTHROPIC_API_KEY;`],
    ['環境変数(文字列)', `const key = process.env['ANTHROPIC_AUTH_TOKEN'];`],
  ])('C-4: Anthropic への参照を見つける: %s', (_label, code) => {
    expect(rulesOf(code)).toContain('anthropic-reference');
  });

  it.each([
    ['node: つきの import', `import { spawn } from 'node:child_process';`],
    ['node: なしの import', `import { exec } from 'child_process';`],
    ['型だけの import', `import type { ChildProcess } from 'node:child_process';`],
    ['名前空間の import', `import * as cp from 'node:child_process';`],
    ['動的 import', `const cp = await import('node:child_process');`],
    ['require', `const { execFile } = require('child_process');`],
    ['import = require', `import cp = require('child_process');`],
    ['createRequire 経由', `const cp = createRequire(import.meta.url)('node:child_process');`],
    ['getBuiltinModule', `const cp = process.getBuiltinModule('node:child_process');`],
    ['cluster(fork)', `import cluster from 'node:cluster';`],
    ['外部パッケージ(execa)', `import { execa } from 'execa';`],
    ['外部パッケージ(cross-spawn)', `import spawn from 'cross-spawn';`],
    ['外部パッケージの配下のパス', `import { $ } from 'zx/core';`],
  ])('C-4: プロセスを起動するモジュールの読み込みを見つける: %s', (_label, code) => {
    expect(rulesOf(code)).toContain('process-launch-module');
  });

  it.each([
    ['変数を渡す動的 import', `const mod = await import(name);`],
    ['文字列を組み立てる require', `const mod = require('child' + '_process');`],
    ['式を埋め込んだテンプレート', 'const mod = await import(`node:${name}`);'],
    ['変数を渡す getBuiltinModule', `const mod = process.getBuiltinModule(name);`],
  ])('C-4: 静的に確かめられないモジュールの読み込みを見つける: %s', (_label, code) => {
    expect(rulesOf(code)).toContain('dynamic-module-specifier');
  });

  it.each([
    ['process.binding', `const spawnSync = process.binding('spawn_sync');`],
    ['process.execve', `process.execve('/bin/sh', ['sh']);`],
    ['process.dlopen', `process.dlopen(module, path);`],
  ])('C-4: process の内部寄りの API を見つける: %s', (_label, code) => {
    expect(rulesOf(code)).toContain('process-internal-api');
  });

  it.each([
    ['コマンド名だけ', `run('claude', ['-p', prompt]);`],
    ['引数つきのコマンド文字列', `run('claude -p "hello"');`],
    ['絶対パス', `run('/usr/local/bin/claude');`],
    ['npx 経由', `run('npx claude --version');`],
    ['シェル経由', `run('sh', ['-c', 'cd /repo && claude -p x']);`],
    ['テンプレート', 'run(`claude -p ${prompt}`);'],
    ['Windows の実行ファイル名', `run('claude.exe');`],
  ])('C-4: claude コマンドに見える文字列を見つける: %s', (_label, code) => {
    expect(rulesOf(code)).toContain('claude-command');
  });

  it('C-4、ルール8: 失敗メッセージ用の文字列には、一致した部分だけが入り、リテラルの全体は入らない', () => {
    const findings = scanCode('src/x.ts', `run('claude -p "DUMMY-VALUE-NOT-A-REAL-KEY"');\nconst k = 'x-anthropic-DUMMY-VALUE-NOT-A-REAL-KEY';`);
    expect(findings.map(formatFinding)).toEqual(['src/x.ts:1 [claude-command] claude', 'src/x.ts:2 [anthropic-reference] anthropic']);
  });

  it('C-4: 違反の位置(ファイル、行、一致した部分、リテラルの全体)を返す', () => {
    const code = ['const a = 1;', '', `import { spawn } from 'node:child_process';`, `spawn('claude');`].join('\n');
    expect(scanCode('src/x.ts', code)).toEqual([
      { file: 'src/x.ts', line: 3, rule: 'process-launch-module', match: 'child_process', literal: 'node:child_process' },
      { file: 'src/x.ts', line: 4, rule: 'claude-command', match: 'claude', literal: 'claude' },
    ]);
  });

  it('C-4: JavaScript と TSX も検査する', () => {
    expect(rulesOf(`const cp = require('child_process');`, 'tool.cjs')).toEqual(['process-launch-module']);
    expect(rulesOf(`export const App = () => <a href="https://api.anthropic.com/">x</a>;`, 'App.tsx')).toEqual([
      'anthropic-reference',
    ]);
  });

  it.each([
    ['コメントの中の語', `// CLAUDE.md のルール1: Claude / Anthropic は呼ばない。@anthropic-ai/sdk も claude コマンドも使わない\nconst a = 1;`],
    ['JSDoc の中の語', `/** child_process で claude を起動しない(api.anthropic.com も呼ばない) */\nexport const a = 1;`],
    ['秘密ファイルのパターン', `const patterns = ['.claude.json', '.claude/credentials.json', '.claude', 'claude.json'];`],
    ['大文字のパターン', `const names = ['.CLAUDE.JSON', '.Claude.Json', 'CLAUDE.md'];`],
    ['一覧の表記', `const entries = ['directory:.claude'];`],
    ['説明文', `const label = 'Claude Code などの AI に、MCP で指示を渡す';`],
    ['プロセスを起動しない組み込みモジュール', `import { readFile } from 'node:fs/promises';\nimport { connect } from 'node:net';`],
    ['文字列リテラルを渡す動的 import', `const { connect } = await import('node:net');`],
    ['普通の文字列としての open / cluster', `const status = 'open';\nconst kind = 'cluster';`],
    ['process の普通の API', `process.on('SIGTERM', stop);\nconst port = process.env.PORT;\nprocess.exit(1);`],
    ['RegExp の exec', `const m = /^(\\d+)-/.exec(name);`],
  ])('C-4: 違反でないコードには反応しない: %s', (_label, code) => {
    expect(scanCode('sample.ts', code)).toEqual([]);
  });
});

describe('C-4: テキストの検出関数(scanText、scanNpmScripts)と、許可リスト', () => {
  it('C-4: シェルのコマンドとして、claude コマンドと Anthropic への参照を見つける', () => {
    const workflow = ['steps:', '  - run: npm ci', '  - run: claude -p "fix it"', '  - run: npx @anthropic-ai/claude-code'].join('\n');
    expect(scanText('.github/workflows/ci.yml', workflow, true)).toEqual([
      { file: '.github/workflows/ci.yml', line: 3, rule: 'claude-command', match: 'claude', literal: 'claude' },
      { file: '.github/workflows/ci.yml', line: 4, rule: 'anthropic-reference', match: 'anthropic', literal: 'anthropic' },
    ]);
  });

  it('C-4: シェルのコメントと、コマンドでない語には反応しない', () => {
    const containerfile = [
      '# claude コマンドも @anthropic-ai/sdk も入れない(CLAUDE.md のルール1)',
      'FROM ubuntu:26.04',
      'COPY CLAUDE.md .claude.json /tmp/',
      'RUN npm ci # claude は使わない',
    ].join('\n');
    expect(scanText('Containerfile', containerfile, true)).toEqual([]);
  });

  it('C-4: シェルでないテキストでは、Anthropic への参照と child_process だけを見る', () => {
    const html = `<script type="module">import('https://esm.sh/@anthropic-ai/sdk');</script>\n<p>claude</p>`;
    expect(scanText('index.html', html, false).map((finding) => finding.rule)).toEqual(['anthropic-reference']);
    expect(scanText('.gitignore', '.claude.json\n.claude/credentials*\n', false)).toEqual([]);
  });

  it.each([
    ['.github/workflows/ci.yml', true],
    ['scripts/run.sh', true],
    ['Containerfile', true],
    ['Dockerfile.dev', true],
    ['src/client/index.html', false],
    ['tsconfig.json', false],
  ])('C-4: シェルのコマンドを書くファイルの判定: %s', (file, expected) => {
    expect(isShellLikeFile(file)).toBe(expected);
  });

  it('C-4: scripts の違反を、スクリプトの名前つきで返す', () => {
    const scripts = {
      test: 'vitest run',
      clean: `node -e "require('node:fs').rmSync('dist', { recursive: true, force: true })"`,
      fix: 'claude -p "fix the tests"',
      ask: 'npx @anthropic-ai/claude-code',
      run: `node -e "require('child_process').execSync('ls')"`,
    };
    expect(scanNpmScripts(scripts).map(formatFinding)).toEqual([
      'package.json#scripts.fix:1 [claude-command] claude',
      'package.json#scripts.ask:1 [anthropic-reference] anthropic',
      'package.json#scripts.run:1 [process-launch-module] child_process',
    ]);
  });

  it('C-4: scripts が読めないときは、違反なしとして扱わずにエラーにする', () => {
    expect(() => scanNpmScripts(undefined)).toThrow();
    expect(() => scanNpmScripts({ build: 1 })).toThrow();
  });

  it('C-4: 許可リストは、ファイル・種類・文字列がすべて一致した違反だけを外す', () => {
    const allowed: AllowedFinding = { file: 'e2e/a.ts', rule: 'process-launch-module', literal: 'node:child_process', reason: 'テスト' };
    const findings: Finding[] = [
      { file: 'e2e/a.ts', line: 1, rule: 'process-launch-module', match: 'child_process', literal: 'node:child_process' },
      // 同じファイルでも、別の種類・別の文字列は許可されない(一致した部分が同じでも、リテラルの全体が違えば許可されない)
      { file: 'e2e/a.ts', line: 2, rule: 'claude-command', match: 'claude', literal: 'claude' },
      { file: 'e2e/a.ts', line: 3, rule: 'process-launch-module', match: 'child_process', literal: 'child_process' },
      // 別のファイルは許可されない
      { file: 'src/b.ts', line: 1, rule: 'process-launch-module', match: 'child_process', literal: 'node:child_process' },
    ];
    const result = applyAllowlist(findings, [allowed]);
    expect(result.violations).toEqual(findings.slice(1));
    expect(result.unusedEntries).toEqual([]);
  });

  it('C-4: 使われていない許可を返す(mustMatch が false のものは除く)', () => {
    const stale: AllowedFinding = { file: 'e2e/gone.ts', rule: 'process-launch-module', literal: 'node:child_process', reason: 'テスト' };
    const optional: AllowedFinding = { ...stale, file: 'e2e/optional.ts', mustMatch: false };
    expect(applyAllowlist([], [stale, optional]).unusedEntries).toEqual([stale]);
  });
});
