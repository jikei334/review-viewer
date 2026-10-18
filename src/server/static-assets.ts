/**
 * 画面(ビルド済みの静的ファイル)の配信
 *
 * 起動時に、画面のビルド成果物のディレクトリを1回だけ走査して、「URL のパス → ファイル」の
 * 対応表を作る。リクエストのパスは、この対応表との**完全一致**でしか引かない
 * (リクエストのパスから、ファイルのパスを組み立てない。`../` などを通す余地を作らないため)。
 * このモジュールが読むのは、アプリ自身のビルド成果物だけで、対象リポジトリのファイルではない
 * (リポジトリの読み取りは RepoReader だけが行う)。
 */
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

/** 対応表の1件 */
interface AssetEntry {
  /** 実体のファイルのパス(起動時の走査で得たもの) */
  readonly file: string;
  /** Content-Type */
  readonly contentType: string;
  /** Cache-Control */
  readonly cacheControl: string;
}

/** 配信するファイルの内容 */
export interface ServedAsset {
  /** 本文 */
  readonly body: Uint8Array;
  /** Content-Type */
  readonly contentType: string;
  /** Cache-Control */
  readonly cacheControl: string;
}

/** 拡張子ごとの Content-Type。ここに無い拡張子は配信しない(想定外のファイルを出さないため) */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/** 画面のビルド成果物を見つけられないときのエラー */
export class StaticAssetsUnavailableError extends Error {
  /**
   * @param cause 元のエラー
   */
  constructor(cause: unknown) {
    super('画面のビルド成果物を読み込めません(npm run build を実行してください)', { cause });
    this.name = 'StaticAssetsUnavailableError';
  }
}

/**
 * ディレクトリを再帰的に走査して、通常のファイルの一覧を返す(シンボリックリンクはたどらない)
 *
 * @param dir 走査するディレクトリ
 * @param urlPrefix このディレクトリに対応する URL のパス(末尾は `/`)
 * @returns `[URL のパス, ファイルのパス]` の配列
 */
async function walk(dir: string, urlPrefix: string): Promise<Array<[string, string]>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: Array<[string, string]> = [];
  for (const entry of entries) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(file, `${urlPrefix}${entry.name}/`)));
    } else if (entry.isFile()) {
      found.push([`${urlPrefix}${entry.name}`, file]);
    }
  }
  return found;
}

/** 画面の静的ファイルの配信元 */
export class StaticAssets {
  private readonly entries: ReadonlyMap<string, AssetEntry>;

  /**
   * @param entries URL のパスとファイルの対応表
   */
  private constructor(entries: ReadonlyMap<string, AssetEntry>) {
    this.entries = entries;
  }

  /**
   * ビルド成果物のディレクトリを走査して、配信元を作る
   *
   * `index.html` が無いディレクトリは、画面が動かないので受け付けない。
   *
   * @param dir 画面のビルド成果物のディレクトリ
   * @returns 配信元
   * @throws StaticAssetsUnavailableError ディレクトリを読めない、または index.html が無いとき
   */
  static async load(dir: string): Promise<StaticAssets> {
    let files: Array<[string, string]>;
    try {
      files = await walk(dir, '/');
    } catch (err) {
      throw new StaticAssetsUnavailableError(err);
    }
    const entries = new Map<string, AssetEntry>();
    for (const [urlPath, file] of files) {
      const contentType = CONTENT_TYPES[extname(file).toLowerCase()];
      if (contentType === undefined) continue;
      const isHtml = urlPath.endsWith('.html');
      entries.set(urlPath, {
        file,
        contentType,
        // HTML は毎回確認させる。assets/ のファイルは、名前に内容のハッシュが入っている
        cacheControl: isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
    }
    if (!entries.has('/index.html')) {
      throw new StaticAssetsUnavailableError(new Error('index.html がありません'));
    }
    return new StaticAssets(entries);
  }

  /**
   * URL のパスに対応するファイルを読む
   *
   * `/` は `/index.html` として扱う。対応表に無いパスは、undefined(404 にする)。
   *
   * @param urlPath リクエストの URL のパス(デコード済み)
   * @returns 配信する内容。対応表に無ければ undefined
   * @throws ファイルを読めなかったとき(走査の後に消された場合など)
   */
  async read(urlPath: string): Promise<ServedAsset | undefined> {
    const entry = this.entries.get(urlPath === '/' ? '/index.html' : urlPath);
    if (entry === undefined) return undefined;
    const body = await readFile(entry.file);
    return { body, contentType: entry.contentType, cacheControl: entry.cacheControl };
  }
}
