/**
 * `.gitignore` による除外の判定(S1-5)
 *
 * パターンの解釈は自前で実装せず、`ignore` パッケージに任せる。ここで行うのは、
 * 「どのディレクトリの `.gitignore` を、どの順で当てるか」の組み立てだけ。
 *
 * git と同じ意味になるように、次の規則で判定する。
 * - ルートと、途中の各ディレクトリの `.gitignore` を使う
 * - 深いディレクトリの `.gitignore` が、浅いものより優先される
 * - 親ディレクトリが除外されていたら、その配下は否定パターン(`!`)でも戻せない
 * - 大文字小文字を区別する(Linux 上の git の既定と同じ)
 *
 * 対象外: `.git/info/exclude`、利用者ごとの除外設定(`core.excludesFile`)。
 *
 * このファイルは、ファイルシステムに直接触れない。`.gitignore` の中身は、
 * RepoReader が渡す読み込み関数から受け取る(ファイルを読む入口を RepoReader だけにするため)。
 */
import ignore, { type Ignore } from 'ignore';

/**
 * あるディレクトリの `.gitignore` の中身を返す関数
 *
 * @param dirSegments ディレクトリの、リポジトリ相対パスの要素(ルートなら空)
 * @returns `.gitignore` の中身。無ければ(または、使ってはいけなければ)null
 */
export type IgnoreRulesLoader = (dirSegments: readonly string[]) => Promise<string | null>;

/**
 * `.gitignore` の判定器(1回の操作の間だけ使う。読み込んだ規則を、その間だけ覚えておく)
 */
export class GitignoreMatcher {
  private readonly loadRules: IgnoreRulesLoader;
  private readonly cache = new Map<string, Promise<Ignore | null>>();

  /**
   * @param loadRules ディレクトリごとの `.gitignore` の中身を返す関数
   */
  constructor(loadRules: IgnoreRulesLoader) {
    this.loadRules = loadRules;
  }

  /**
   * あるディレクトリの `.gitignore` を読み込んで、判定器にする(同じディレクトリは1回だけ読む)
   *
   * @param dirSegments ディレクトリの、リポジトリ相対パスの要素
   * @returns `ignore` の判定器。`.gitignore` が無ければ null
   */
  private rulesFor(dirSegments: readonly string[]): Promise<Ignore | null> {
    // 要素に `/` は含まれない(path-policy.ts で検証済み)ので、`/` でつないだ文字列をキーにできる
    const key = dirSegments.join('/');
    let pending = this.cache.get(key);
    if (pending === undefined) {
      pending = this.loadRules(dirSegments).then((content) =>
        content === null ? null : ignore({ ignorecase: false }).add(content)
      );
      this.cache.set(key, pending);
    }
    return pending;
  }

  /**
   * パスが `.gitignore` で除外されているかを調べる
   *
   * パスの先頭から1要素ずつ伸ばしながら調べ、途中のディレクトリが除外されていたら、
   * その時点で「除外」とする。
   *
   * @param segments リポジトリ相対パスの要素(ルートなら空)
   * @param isDirectory パスがディレクトリを指すなら true(`build/` のようなパターンの判定に使う)
   * @returns 除外されていれば true。ルートは除外されない
   * @throws `.gitignore` を読み込めなかったとき(読み込み関数のエラーをそのまま伝える)
   */
  async isIgnored(segments: readonly string[], isDirectory: boolean): Promise<boolean> {
    for (let end = 1; end <= segments.length; end += 1) {
      // 途中の要素は、必ずディレクトリ
      const targetIsDirectory = end < segments.length || isDirectory;
      // 深いディレクトリの .gitignore から順に当てる。最初に当たった規則で決まる
      for (let base = end - 1; base >= 0; base -= 1) {
        const rules = await this.rulesFor(segments.slice(0, base));
        if (rules === null) continue;
        // `ignore` は、ディレクトリを末尾の `/` で区別する(README の「filenames and dirnames」)
        const relative = segments.slice(base, end).join('/') + (targetIsDirectory ? '/' : '');
        const result = rules.test(relative);
        if (result.ignored) return true;
        // 否定パターンで戻された。浅いほうの .gitignore は見ない
        if (result.unignored) break;
      }
    }
    return false;
  }
}
