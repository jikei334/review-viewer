/**
 * ReviewService: Web API と MCP が共有する業務ロジック(SPEC §2)
 *
 * Web API(app.ts)と、ステージ3の MCP は、ここを呼ぶ薄いアダプタにする。
 * ファイルは、必ず RepoReader を通して読む(このファイルは `fs` に触れない)。
 *
 * 暫定の方針(SPEC に定めが無く、人間に確認中のもの)は、このファイルの定数と
 * 小さな関数(`REPORTS_DIR`、`isReportFile`、`compareReportsNewestFirst`)にまとめてある。
 */
import { buildQuote, hashContent, splitLines } from './comment-anchor.js';
import { InputError, type CommentFilter, type CreateCommentInput } from './comment-input.js';
import { RepoAccessError } from './path-policy.js';
import type { RepoEntry, RepoEntryType, RepoFile, RepoReader } from './RepoReader.js';
import type { CommentAuthor, ReviewStore, StoredComment } from './ReviewStore.js';

/** API で返すコメント(`position` は後続のタスクで足す) */
export type Comment = StoredComment;

/** レポートを置くディレクトリ(リポジトリ相対) */
export const REPORTS_DIR = 'reports';

/** レポート一覧の1件 */
export interface ReportSummary {
  /** ファイル名(例: `2026-10-12-feature.md`) */
  readonly name: string;
  /** リポジトリ相対パス(例: `reports/2026-10-12-feature.md`) */
  readonly path: string;
  /** 更新日時(ISO 8601、UTC) */
  readonly modifiedAt: string;
}

/** ツリーの1件 */
export interface TreeEntry {
  /** 名前 */
  readonly name: string;
  /** リポジトリ相対パス */
  readonly path: string;
  /** 種類 */
  readonly type: RepoEntryType;
}

/** ディレクトリの一覧 */
export interface TreeListing {
  /** リポジトリ相対パス(ルートなら空文字列) */
  readonly path: string;
  /** 配下の一覧(ディレクトリが先、その中は名前の昇順) */
  readonly entries: readonly TreeEntry[];
}

/** ReviewService が使うもの */
export interface ReviewServiceDeps {
  /** ファイルを読む入口 */
  readonly repoReader: Pick<RepoReader, 'listDirectory' | 'readFile'>;
  /** コメントを保存する入口(読み込み済みのもの) */
  readonly store: Pick<ReviewStore, 'list' | 'add'>;
}

/**
 * レポートとして扱うファイルかどうかを調べる(SPEC の `reports/*.md`)
 *
 * 暫定の方針: `reports/` の直下の、名前が `.md` で終わる通常のファイルだけ
 * (サブディレクトリの中は含めない。拡張子の大文字小文字は区別する)。
 *
 * @param entry `reports/` の直下の1件
 * @returns レポートなら true
 */
export function isReportFile(entry: Pick<RepoEntry, 'name' | 'type'>): boolean {
  return entry.type === 'file' && entry.name.endsWith('.md');
}

/**
 * レポートを「新しい順」に並べるための比較関数(S1-1)
 *
 * 暫定の方針: 更新日時(mtime)の降順。同じ時刻なら、ファイル名の降順。
 *
 * @param a 比べる1件目
 * @param b 比べる2件目
 * @returns a を先にするなら負、b を先にするなら正、同じなら 0
 */
export function compareReportsNewestFirst(
  a: Pick<RepoEntry, 'name' | 'mtimeMs'>,
  b: Pick<RepoEntry, 'name' | 'mtimeMs'>
): number {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  if (a.name === b.name) return 0;
  return a.name < b.name ? 1 : -1;
}

/**
 * ツリーの並び順の比較関数(ディレクトリが先、その中は名前の昇順)
 *
 * @param a 比べる1件目
 * @param b 比べる2件目
 * @returns a を先にするなら負、b を先にするなら正、同じなら 0
 */
export function compareTreeEntries(
  a: Pick<RepoEntry, 'name' | 'type'>,
  b: Pick<RepoEntry, 'name' | 'type'>
): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * Web API と MCP が共有する業務ロジック
 */
export class ReviewService {
  private readonly repoReader: ReviewServiceDeps['repoReader'];
  private readonly store: ReviewServiceDeps['store'];

  /**
   * @param deps ファイルを読む入口と、コメントを保存する入口
   */
  constructor(deps: ReviewServiceDeps) {
    this.repoReader = deps.repoReader;
    this.store = deps.store;
  }

  /**
   * レポートの一覧を、新しい順に返す(S1-1)
   *
   * 拒否対象(秘密ファイル、`.gitignore` の対象、リポジトリの外を指すリンク)は含まれない。
   * `reports/` が無い、または拒否対象のときは、空の一覧を返す。
   *
   * @returns レポートの一覧(新しい順)
   * @throws リポジトリを読めなかったとき(RepoReader のエラーをそのまま伝える)
   */
  async listReports(): Promise<ReportSummary[]> {
    let entries: readonly RepoEntry[];
    try {
      entries = (await this.repoReader.listDirectory(REPORTS_DIR)).entries;
    } catch (err) {
      // reports/ が無いのは、誤りではなく「レポートがまだ無い」状態
      if (err instanceof RepoAccessError && err.code === 'not_found') return [];
      throw err;
    }
    return entries
      .filter(isReportFile)
      .sort(compareReportsNewestFirst)
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        modifiedAt: new Date(entry.mtimeMs).toISOString(),
      }));
  }

  /**
   * ディレクトリの一覧を返す(1階層だけ。拒否対象は含めない)
   *
   * @param path リポジトリ相対パス(空文字列ならルート。SPEC §2.2)
   * @returns 一覧(ディレクトリが先、その中は名前の昇順)
   * @throws RepoAccessError パスの形式が正しくない、存在しない、拒否対象、ディレクトリでないとき
   */
  async listTree(path: string): Promise<TreeListing> {
    const directory = await this.repoReader.listDirectory(path);
    const entries = [...directory.entries]
      .sort(compareTreeEntries)
      .map((entry) => ({ name: entry.name, path: entry.path, type: entry.type }));
    return { path: directory.path, entries };
  }

  /**
   * ファイルの内容を返す。巨大ファイルとバイナリは、本文を返さず、その旨を返す(S1-6)
   *
   * @param path リポジトリ相対パス
   * @returns ファイルの内容(`kind` が `text` のときだけ本文を持つ)
   * @throws RepoAccessError パスの形式が正しくない、存在しない、拒否対象、通常のファイルでないとき
   */
  async getFile(path: string): Promise<RepoFile> {
    return this.repoReader.readFile(path);
  }

  /**
   * コメントを作成して保存する(S2-1、S2-4)
   *
   * 対象のファイルは RepoReader で読む(パスの検証は RepoReader に任せる。別の検証は作らない)。
   * `quote` と `docHash` はここで作る。`author` は呼び出し側(Web は human、MCP は ai)が決める。
   *
   * @param input 検証済みの入力(`parseCreateCommentInput` の結果)
   * @param author コメントの作者
   * @returns 作成したコメント
   * @throws RepoAccessError パスが存在しない・拒否対象・ディレクトリのとき(404)
   * @throws InputError ファイルが巨大またはバイナリ、行範囲がファイルの行数を超えるとき(400)
   * @throws ReviewStoreError 保存できなかったとき
   */
  async createComment(input: CreateCommentInput, author: CommentAuthor): Promise<Comment> {
    const file = await this.repoReader.readFile(input.path);
    if (file.kind !== 'text') throw new InputError('このファイルにはコメントを付けられません');
    const lines = splitLines(file.content);
    if (input.endLine > lines.length) throw new InputError('endLine がファイルの行数を超えています');
    return this.store.add({
      // RepoReader が返した正規化済みのパスを保存する
      path: file.path,
      anchor: {
        startLine: input.startLine,
        endLine: input.endLine,
        quote: buildQuote(lines, input.startLine, input.endLine),
        docHash: hashContent(file.content),
      },
      body: input.body,
      author,
      type: input.type,
    });
  }

  /**
   * コメントの一覧を返す(作成日時の昇順。同時刻は作成順)(S2-1、S2-4)
   *
   * `path` の絞り込みは、保存されているコメントの `path` との文字列の比較だけで行い、
   * RepoReader(ファイルシステム)を呼ばない。存在しない・拒否対象のパスも、空の一覧になる。
   *
   * @param filter 指定した条件だけを持つ絞り込み(形式は検証済み)
   * @returns コメントの配列
   */
  listComments(filter: CommentFilter = {}): Comment[] {
    // 保存順は作成順。安定ソートなので、同じ日時は作成順のまま残る
    return this.store
      .list()
      .filter(
        (c) =>
          (filter.path === undefined || c.path === filter.path) &&
          (filter.status === undefined || c.status === filter.status) &&
          (filter.type === undefined || c.type === filter.type)
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
}
