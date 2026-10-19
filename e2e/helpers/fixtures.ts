/**
 * e2e テスト用の、動的に作るフィクスチャ
 *
 * 秘密ファイルに「見える」ダミーを作る。中身はすべてダミーの文字列で、本物の秘密は含まない。
 * これらのファイル名は、このリポジトリ自身の .gitignore にも一致するため、
 * コミット済みフィクスチャ(e2e/fixtures/repo)には置かず、テストのたびに一時ディレクトリへ作る。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 拒否されるべきファイル1件 */
export interface DeniedFile {
  /** リポジトリ相対パス */
  path: string;
  /** ファイルの中身に埋め込んだ、一意な目印。応答やログに出てはいけない */
  sentinel: string;
  /** 拒否される理由(テスト名に使う) */
  reason: string;
}

/**
 * 目印の文字列を作る
 * @param index 通し番号
 * @returns ダミーであることが分かる、一意な文字列
 */
function makeSentinel(index: number): string {
  return `E2E_DUMMY_SECRET_SENTINEL_${String(index).padStart(2, '0')}_NOT_A_REAL_SECRET`;
}

/** SPEC S1-5 に列挙された、秘密ファイルのパターンに一致するパス */
const SECRET_PATHS: ReadonlyArray<readonly [path: string, reason: string]> = [
  ['.env', '.env*'],
  ['.env.local', '.env*'],
  ['.env.production', '.env*'],
  // 決定済み(2026-10-18, Q6): .env* は文字どおりに扱い、.env.example も拒否する。
  // ルートの .gitignore の否定パターン(!.env.example)があっても、秘密ファイルの判定は解除されない(Q9)
  ['.env.example', '.env*(.env.example。.gitignore の否定パターンがあっても拒否)'],
  ['subdir/.env', '.env*(サブディレクトリ)'],
  ['.git/config', '.git/'],
  ['.git/HEAD', '.git/'],
  ['secret.pem', '*.pem'],
  ['server.key', '*.key'],
  ['subdir/nested/private.key', '*.key(サブディレクトリ)'],
  ['id_rsa', 'id_rsa*'],
  ['id_rsa.pub', 'id_rsa*'],
  ['credentials', 'credentials*'],
  ['credentials.json', 'credentials*'],
  ['.claude.json', '.claude.json'],
];

/** フィクスチャの .gitignore の内容 */
const GITIGNORE_CONTENT = [
  'excluded-by-git.txt',
  '*.log',
  // 否定パターン: *.log のうち important.log だけは除外されない(git と同じ意味)
  '!important.log',
  'build-out/',
  'reports/2026-12-31-ignored.md',
  // 秘密ファイルの判定は、否定パターンでは解除されない
  '!.env.example',
  '',
].join('\n');

/** サブディレクトリ subdir/.gitignore の内容(決定済み 2026-10-18, Q9: サブディレクトリの .gitignore も扱う) */
const SUBDIR_GITIGNORE_CONTENT = [
  'sub-ignored.txt',
  // 先頭のスラッシュは、この .gitignore のあるディレクトリ(subdir/)の直下だけを指す
  '/anchored.txt',
  // 秘密ファイルの判定は、否定パターンでは解除されない(subdir/.env は拒否されたまま)
  '!.env',
  '!*.key',
  '',
].join('\n');

/** 上の .gitignore で除外されるパス */
const GITIGNORED_PATHS: ReadonlyArray<readonly [path: string, reason: string]> = [
  ['excluded-by-git.txt', '.gitignore(ファイル名の指定)'],
  ['debug.log', '.gitignore(*.log)'],
  ['subdir/trace.log', '.gitignore(*.log、サブディレクトリ)'],
  ['build-out/artifact.txt', '.gitignore(build-out/)'],
  ['reports/2026-12-31-ignored.md', '.gitignore(reports/ 配下のレポート)'],
  ['subdir/sub-ignored.txt', 'subdir/.gitignore(ファイル名の指定)'],
  ['subdir/anchored.txt', 'subdir/.gitignore(/anchored.txt。subdir の直下)'],
];

/** .gitignore の否定パターンや適用範囲のおかげで、除外されず、見えて取得できるべきファイル */
export const VISIBLE_DESPITE_GITIGNORE: ReadonlyArray<{ path: string; sentinel: string; reason: string }> = [
  { path: 'important.log', sentinel: 'E2E_VISIBLE_IMPORTANT_LOG_SENTINEL', reason: '否定パターン(!important.log)' },
  {
    path: 'subdir/nested/anchored.txt',
    sentinel: 'E2E_VISIBLE_NESTED_ANCHORED_SENTINEL',
    reason: 'subdir/.gitignore の /anchored.txt は subdir の直下だけを指す',
  },
];

/**
 * 拒否されるべきファイル(秘密ファイルに見えるダミーと、.gitignore の対象)を作る
 *
 * @param repoDir 一時的な REPO_DIR
 * @returns 作ったファイルの一覧(パス、目印、理由)
 */
export async function createDeniedFiles(repoDir: string): Promise<DeniedFile[]> {
  const created: DeniedFile[] = [];
  const all = [...SECRET_PATHS, ...GITIGNORED_PATHS];
  for (const [index, [path, reason]] of all.entries()) {
    const sentinel = makeSentinel(index);
    const full = join(repoDir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `# e2e のダミー(本物の秘密ではない)\nDUMMY=${sentinel}\n`);
    created.push({ path, sentinel, reason });
  }
  await writeFile(join(repoDir, '.gitignore'), GITIGNORE_CONTENT);
  await writeFile(join(repoDir, 'subdir/.gitignore'), SUBDIR_GITIGNORE_CONTENT);
  for (const v of VISIBLE_DESPITE_GITIGNORE) {
    const full = join(repoDir, v.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, `# e2e のダミー\nVISIBLE=${v.sentinel}\n`);
  }
  return created;
}

/**
 * 拒否されるべきファイルの一覧を、ファイルを作らずに返す(テスト名の列挙用)
 * @returns パス、目印、理由の一覧。`createDeniedFiles` が作るものと同じ
 */
export function listDeniedFiles(): DeniedFile[] {
  return [...SECRET_PATHS, ...GITIGNORED_PATHS].map(([path, reason], index) => ({
    path,
    sentinel: makeSentinel(index),
    reason,
  }));
}
