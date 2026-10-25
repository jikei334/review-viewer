/**
 * ReviewStore: コメントを保存先(`<保存先>/comments.json`)に書く、唯一の入口(SPEC §2.1)
 *
 * - 書き込むのはこのサーバー1プロセスだけ。書き込みはプロセス内で直列化する(キュー)
 * - 書き込みは、同じディレクトリの一時ファイルへ書いてから rename する(途中で落ちても壊れない)。
 *   一時ファイルは fsync してから rename する(rename した直後の電源断で、空のファイルが残らないように)
 * - 書き込み先は保存先のディレクトリだけ。対象リポジトリ(`/repo`)には触れない
 * - `comments.json` が壊れていたら、黙って空にせず、理由つきで失敗させる(コメントを失わないため)
 * - ID と時刻は注入できる(`newId`、`now`)
 *
 * 保存の形(外部の契約ではない):
 * `{ "version": 1, "comments": [ <StoredComment>, ... ] }`。`comments` は作成順。
 * `position` は保存しない(読み取りのたびに計算する。SPEC §2.2)。
 */
import { randomUUID } from 'node:crypto';
import { promises as nodeFs } from 'node:fs';
import { join } from 'node:path';

/** コメントの作者 */
export type CommentAuthor = 'human' | 'ai';
/** コメントの種類 */
export type CommentType = 'note' | 'instruction';
/** コメントの状態 */
export type CommentStatus = 'open' | 'resolved' | 'wontfix';

/** コメントの位置(作成時点の情報。変えない) */
export interface StoredAnchor {
  /** 開始行(1 始まり) */
  readonly startLine: number;
  /** 終了行(1 始まり。開始行以上) */
  readonly endLine: number;
  /** 選択範囲の行を `\n` でつないだ文字列 */
  readonly quote: string;
  /** 作成時点のファイル内容の SHA-256(小文字の16進 64 文字) */
  readonly docHash: string;
}

/** 返信 */
export interface StoredReply {
  readonly id: string;
  readonly author: CommentAuthor;
  readonly body: string;
  /** ISO 8601(UTC) */
  readonly createdAt: string;
}

/** 保存されるコメント */
export interface StoredComment {
  readonly id: string;
  /** リポジトリ相対パス(正規の形) */
  readonly path: string;
  readonly anchor: StoredAnchor;
  readonly body: string;
  readonly author: CommentAuthor;
  readonly type: CommentType;
  readonly status: CommentStatus;
  readonly replies: readonly StoredReply[];
  /** 解決時の説明。無ければ null */
  readonly resolution: string | null;
  /** ISO 8601(UTC) */
  readonly createdAt: string;
  /** ISO 8601(UTC) */
  readonly updatedAt: string;
}

/** 新しいコメントの内容(ID・時刻・状態・返信はストアが決める) */
export interface NewComment {
  readonly path: string;
  readonly anchor: StoredAnchor;
  readonly body: string;
  readonly author: CommentAuthor;
  readonly type: CommentType;
}

/** 保存ファイルの名前 */
export const COMMENTS_FILE = 'comments.json';
/** 保存ファイルの形の版番号 */
export const STORE_VERSION = 1;

/** ReviewStore が使うファイル操作(テストで差し替える。書き込みはここだけを通す) */
export interface StoreFs {
  /**
   * ファイルを文字列として読む
   * @param path ファイルのパス
   * @returns 内容(無ければ `code === 'ENOENT'` の例外)
   */
  readFile(path: string): Promise<string>;
  /**
   * 新しいファイルに内容を書いて、ディスクへ反映(fsync)する。すでにあれば失敗する
   * @param path 一時ファイルのパス
   * @param data 書く内容
   * @returns なし
   */
  writeFileSynced(path: string, data: string): Promise<void>;
  /**
   * ファイルを置き換える(rename)
   * @param from 元
   * @param to 先
   * @returns なし
   */
  rename(from: string, to: string): Promise<void>;
  /**
   * ファイルを消す
   * @param path ファイルのパス
   * @returns なし
   */
  unlink(path: string): Promise<void>;
  /**
   * ディレクトリ直下のエントリ名を列挙する
   * @param path ディレクトリのパス
   * @returns 名前の配列(パスは含まない)
   */
  listDir(path: string): Promise<string[]>;
}

/** 実際のファイルシステムを使う操作 */
export const realStoreFs: StoreFs = {
  readFile: (path) => nodeFs.readFile(path, 'utf8'),
  async writeFileSynced(path, data) {
    // flag 'wx': すでにあるファイル(他者が置いたシンボリックリンクを含む)には書かない。所有者だけが読み書きできる権限
    const handle = await nodeFs.open(path, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (path) => nodeFs.unlink(path),
  listDir: (path) => nodeFs.readdir(path),
};

/**
 * このストアが作る一時ファイルの名前の形(`comments.json.<pid>.<連番>.tmp`)
 * 掃除の対象はこの形に完全一致するものだけ。`comments.json` 本体や、保存先の他のファイルは消さない
 */
const TEMP_FILE_PATTERN = /^comments\.json\.\d+\.\d+\.tmp$/;

/** 終了処理中に書き込みを受け付けないときのエラー(HTTP では 503) */
export class StoreClosingError extends Error {
  constructor() {
    super('終了処理中のため、書き込みを受け付けられません');
    this.name = 'StoreClosingError';
  }
}

/** 起動時の掃除の結果 */
export interface TempCleanupResult {
  /** 消した一時ファイルの数 */
  readonly removed: number;
  /** 消せなかった一時ファイルの数 */
  readonly failed: number;
}

/** ストアの失敗(保存ファイルが壊れている、書き込めないなど)。メッセージにコメントの中身を含めない */
export class ReviewStoreError extends Error {
  /**
   * @param message 理由(コメントの本文や秘密を含めない。C-5)
   * @param options 原因(ログには出さない)
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReviewStoreError';
  }
}

/** ReviewStore の作成に必要なもの */
export interface ReviewStoreOptions {
  /** 保存先のディレクトリ(存在し、書き込めること。data-dir.ts が確かめる) */
  readonly dataDir: string;
  /** ファイル操作(省略時は実際のファイルシステム) */
  readonly fs?: StoreFs;
  /** ID の生成(省略時は UUID) */
  readonly newId?: () => string;
  /** 現在時刻(省略時は `new Date()`) */
  readonly now?: () => Date;
}

/**
 * 値が、プレーンなオブジェクトか
 *
 * @param value 調べる値
 * @returns オブジェクト(配列と null を除く)なら true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 整数(1 以上)か
 *
 * @param value 調べる値
 * @returns 1 以上の安全な整数なら true
 */
function isLineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * 保存されたコメント1件の形を確かめる
 *
 * 読み込み時の検査(壊れた・手で編集された保存ファイルを、黙って受け入れないため)。
 *
 * @param value 調べる値
 * @returns StoredComment の形なら true
 */
function isStoredComment(value: unknown): value is StoredComment {
  if (!isRecord(value)) return false;
  const a = value['anchor'];
  if (!isRecord(a)) return false;
  const replies = value['replies'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['path'] === 'string' &&
    isLineNumber(a['startLine']) &&
    isLineNumber(a['endLine']) &&
    typeof a['quote'] === 'string' &&
    typeof a['docHash'] === 'string' &&
    typeof value['body'] === 'string' &&
    (value['author'] === 'human' || value['author'] === 'ai') &&
    (value['type'] === 'note' || value['type'] === 'instruction') &&
    (value['status'] === 'open' || value['status'] === 'resolved' || value['status'] === 'wontfix') &&
    Array.isArray(replies) &&
    replies.every(
      (r) =>
        isRecord(r) &&
        typeof r['id'] === 'string' &&
        (r['author'] === 'human' || r['author'] === 'ai') &&
        typeof r['body'] === 'string' &&
        typeof r['createdAt'] === 'string'
    ) &&
    (value['resolution'] === null || typeof value['resolution'] === 'string') &&
    typeof value['createdAt'] === 'string' &&
    typeof value['updatedAt'] === 'string'
  );
}

/**
 * 保存ファイルの内容を解析して、コメントの配列にする
 *
 * @param text ファイルの内容
 * @returns コメントの配列
 * @throws ReviewStoreError JSON でない、版番号が違う、形が違うとき(内容は例外に含めない)
 */
export function parseStoreFile(text: string): StoredComment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    throw new ReviewStoreError(`${COMMENTS_FILE} が壊れています(JSON として読めません)`, { cause: err });
  }
  if (!isRecord(parsed) || parsed['version'] !== STORE_VERSION || !Array.isArray(parsed['comments'])) {
    throw new ReviewStoreError(`${COMMENTS_FILE} の形式が想定と違います(version=${STORE_VERSION} の形ではありません)`);
  }
  const comments: unknown[] = parsed['comments'];
  if (!comments.every(isStoredComment)) {
    throw new ReviewStoreError(`${COMMENTS_FILE} に、形式が想定と違うコメントが含まれています`);
  }
  return comments;
}

/** 該当の ID のコメントが無いときのエラー(HTTP では 404) */
export class CommentNotFoundError extends Error {
  constructor() {
    super('コメントが見つかりません');
    this.name = 'CommentNotFoundError';
  }
}

/**
 * 変更時刻を決める(前の時刻より厳密に後になるようにする)
 *
 * @param now 現在時刻
 * @param previous 前の `updatedAt`(ISO 8601)
 * @returns ISO 8601(ミリ秒を含む)。`now` が前の時刻以前なら、前の時刻の1ミリ秒後
 */
export function nextTimestamp(now: Date, previous: string): string {
  const prev = Date.parse(previous);
  return new Date(Math.max(now.getTime(), prev + 1)).toISOString();
}

/**
 * コメントの保存先への、唯一の書き込み口
 */
export class ReviewStore {
  private readonly filePath: string;
  private readonly dataDir: string;
  private readonly fs: StoreFs;
  private readonly newId: () => string;
  private readonly now: () => Date;
  /** メモリ上のコメント(作成順)。書き込みに成功してから更新する */
  private comments: StoredComment[] = [];
  private loaded = false;
  /** 終了処理が始まったら true。以後の書き込みは受け付けない */
  private closing = false;
  /** 直列化のための、末尾の処理 */
  private tail: Promise<unknown> = Promise.resolve();
  /** 一時ファイル名の重複を避ける連番 */
  private tempCounter = 0;

  /**
   * @param options 保存先、ファイル操作、ID の生成、現在時刻
   */
  constructor(options: ReviewStoreOptions) {
    this.dataDir = options.dataDir;
    this.filePath = join(options.dataDir, COMMENTS_FILE);
    this.fs = options.fs ?? realStoreFs;
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 保存ファイルを読み込む(起動時に1回呼ぶ)
   *
   * ファイルが無ければ空で始める。壊れていたら、黙って空にせず失敗させる。
   *
   * @returns 読み込めたら解決する
   * @throws ReviewStoreError 壊れている、または読めないとき
   */
  load(): Promise<void> {
    return this.enqueue(async () => {
      let text: string;
      try {
        text = await this.fs.readFile(this.filePath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.comments = [];
          this.loaded = true;
          return;
        }
        throw new ReviewStoreError(`${COMMENTS_FILE} を読み込めません`, { cause: err });
      }
      this.comments = parseStoreFile(text);
      this.loaded = true;
    });
  }

  /**
   * コメントの一覧を返す(作成順。呼び出し側が変更しても内部に影響しない複製)
   *
   * @returns コメントの配列
   * @throws ReviewStoreError load() の前に呼んだとき
   */
  list(): StoredComment[] {
    this.assertLoaded();
    return structuredClone(this.comments);
  }

  /**
   * コメントを1件追加して保存する
   *
   * ID と作成日時はここで決める。保存に失敗したら、メモリ上にも追加しない。
   *
   * @param input コメントの内容
   * @returns 保存したコメント(`status` は open、`replies` は空)
   * @throws ReviewStoreError 保存できなかったとき
   */
  add(input: NewComment): Promise<StoredComment> {
    this.assertAccepting();
    return this.enqueue(async () => {
      this.assertLoaded();
      const at = this.now().toISOString();
      const comment: StoredComment = {
        id: this.newId(),
        path: input.path,
        anchor: { ...input.anchor },
        body: input.body,
        author: input.author,
        type: input.type,
        status: 'open',
        replies: [],
        resolution: null,
        createdAt: at,
        updatedAt: at,
      };
      await this.persist([...this.comments, comment]);
      this.comments = [...this.comments, comment];
      return structuredClone(comment);
    });
  }

  /**
   * コメントのステータスと resolution を変更して保存する
   *
   * 読み取り→変更→書き込みを、キューの1つの区間で行う(並行しても更新が失われない)。
   * `updatedAt` は、同じ値への変更でも進む。
   *
   * @param id コメントの ID
   * @param change 変更後の status と resolution(検証済み)
   * @returns 更新後のコメント
   * @throws CommentNotFoundError 該当の ID が無いとき
   * @throws ReviewStoreError 保存できなかったとき
   */
  updateStatus(id: string, change: Pick<StoredComment, 'status' | 'resolution'>): Promise<StoredComment> {
    return this.mutate(id, (current, at) => ({
      ...current,
      status: change.status,
      resolution: change.resolution,
      updatedAt: at,
    }));
  }

  /**
   * コメントに返信を1件追加して保存する
   *
   * 返信の ID と日時はここで決める。コメントの `updatedAt` も進む。
   *
   * @param id コメントの ID
   * @param reply 返信の作者と本文(検証済み)
   * @returns 更新後のコメント
   * @throws CommentNotFoundError 該当の ID が無いとき
   * @throws ReviewStoreError 保存できなかったとき
   */
  addReply(id: string, reply: Pick<StoredReply, 'author' | 'body'>): Promise<StoredComment> {
    return this.mutate(id, (current, at) => ({
      ...current,
      replies: [...current.replies, { id: this.newId(), author: reply.author, body: reply.body, createdAt: at }],
      updatedAt: at,
    }));
  }

  /**
   * 1件のコメントを、排他区間の中で読み取り→変更→保存する
   *
   * 保存に失敗したら、メモリ上も変えない。変更の時刻は、前の `updatedAt` より厳密に後にする
   * (時計が同じ値・過去を返しても、1ミリ秒だけ進める)。
   *
   * @param id コメントの ID
   * @param build 現在のコメントと変更時刻から、新しいコメントを作る純粋な関数
   * @returns 更新後のコメントの複製
   * @throws CommentNotFoundError 該当の ID が無いとき
   * @throws ReviewStoreError 保存できなかったとき
   */
  private mutate(id: string, build: (current: StoredComment, at: string) => StoredComment): Promise<StoredComment> {
    this.assertAccepting();
    return this.enqueue(async () => {
      this.assertLoaded();
      const index = this.comments.findIndex((c) => c.id === id);
      const current = this.comments[index];
      if (current === undefined) throw new CommentNotFoundError();
      const updated = build(current, nextTimestamp(this.now(), current.updatedAt));
      const next = this.comments.map((c, i) => (i === index ? updated : c));
      await this.persist(next);
      this.comments = next;
      return structuredClone(updated);
    });
  }

  /**
   * 終了処理を始める。以後の書き込み(add / updateStatus / addReply)は StoreClosingError で断る
   *
   * すでに受け付けた書き込みは断らず、drain() で完了を待てる。何度呼んでもよい。
   *
   * @returns なし
   */
  beginShutdown(): void {
    this.closing = true;
  }

  /**
   * 書き込みを受け付けられる状態か確かめる(同期的に確かめる: 受け付けたものだけがキューに入る)
   *
   * @returns なし
   * @throws StoreClosingError 終了処理中のとき
   */
  private assertAccepting(): void {
    if (this.closing) throw new StoreClosingError();
  }

  /**
   * 前回の落ち方(SIGKILL など)で残った一時ファイルを消す(起動時、待ち受けの前に呼ぶ)
   *
   * 消すのは `comments.json.<数字>.<数字>.tmp` の形に完全一致する名前だけ。`comments.json` と
   * 他のファイルは消さない。1件の削除失敗では止めない(残った一時ファイルは害がなく、次回また掃除される)が、
   * 失敗の数を返すので、呼び出し側がログに出す。
   *
   * @returns 消した数と消せなかった数
   * @throws ReviewStoreError 保存先を一覧できないとき(load も同じ理由で失敗するので、起動を止める)
   */
  async cleanupTempFiles(): Promise<TempCleanupResult> {
    let names: string[];
    try {
      names = await this.fs.listDir(this.dataDir);
    } catch (err: unknown) {
      throw new ReviewStoreError('保存先の一時ファイルを調べられません', { cause: err });
    }
    let removed = 0;
    let failed = 0;
    for (const name of names) {
      if (!TEMP_FILE_PATTERN.test(name)) continue;
      try {
        await this.fs.unlink(join(this.dataDir, name));
        removed += 1;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        failed += 1;
      }
    }
    return { removed, failed };
  }

  /**
   * 受け付け済みの書き込みがすべて終わるのを待つ(終了処理で使う)
   *
   * @returns キューが空になったら解決する。個々の失敗は、それぞれの呼び出し元に伝わっているのでここでは投げない
   */
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  /**
   * 処理をキューの末尾に積む(前の処理の成否にかかわらず、順番に1つずつ実行する)
   *
   * @param task 実行する処理
   * @returns 処理の結果
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /**
   * load() 済みであることを確かめる
   *
   * @returns なし
   * @throws ReviewStoreError 未読み込みのとき(空のまま書いて、既存のコメントを消さないため)
   */
  private assertLoaded(): void {
    if (!this.loaded) throw new ReviewStoreError('ReviewStore が読み込まれていません');
  }

  /**
   * コメント全体を、一時ファイルへ書いてから rename で置き換える
   *
   * 失敗したら一時ファイルを消す(`comments.json` は変わらない)。
   *
   * @param comments 保存するコメント(作成順)
   * @returns 保存できたら解決する
   * @throws ReviewStoreError 書き込みまたは rename に失敗したとき
   */
  private async persist(comments: readonly StoredComment[]): Promise<void> {
    const data = `${JSON.stringify({ version: STORE_VERSION, comments }, null, 2)}\n`;
    this.tempCounter += 1;
    const tempPath = join(this.dataDir, `${COMMENTS_FILE}.${process.pid}.${this.tempCounter}.tmp`);
    try {
      await this.fs.writeFileSynced(tempPath, data);
      await this.fs.rename(tempPath, this.filePath);
    } catch (err: unknown) {
      await this.removeTemp(tempPath);
      throw new ReviewStoreError(`${COMMENTS_FILE} を保存できません`, { cause: err });
    }
  }

  /**
   * 一時ファイルを消す。無ければ何もしない
   *
   * 消せなかったときも、元の失敗を隠さないよう投げない(元のエラーを呼び出し元へ伝える)。
   * 残った一時ファイルは、次回の起動時の掃除(cleanupTempFiles)で消す。
   *
   * @param tempPath 一時ファイルのパス
   * @returns なし
   */
  private async removeTemp(tempPath: string): Promise<void> {
    try {
      await this.fs.unlink(tempPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      // 元の失敗を優先して伝える。ここの失敗は、残った一時ファイルが後で掃除されるだけで済む
      process.stderr.write(`Review Viewer: 一時ファイルを消せませんでした(${errorCodeOf(err)})\n`);
    }
  }
}

/**
 * 失敗の原因から、ログに出してよいエラーコードを取り出す
 *
 * @param err 捕まえた値
 * @returns エラーコード。無ければ `不明`
 */
function errorCodeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : '不明';
}
