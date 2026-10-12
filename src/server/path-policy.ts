/**
 * リポジトリ相対パスの検証と、秘密ファイルの判定(S1-4、S1-5)
 *
 * 副作用のない関数だけを置く(ファイルシステムには触れない)。
 * ここでの検査は文字列だけなので、これだけでは足りない。実体のパス(realpath)が
 * リポジトリの中にあることの確認は、RepoReader が行う。
 *
 * 暫定の方針(SPEC に定めが無く、人間に確認中のもの)は、このファイルの定数にまとめてある。
 */

/** パスを受け付けられない理由(API の応答に出してよい、固定の分類) */
export type RepoAccessCode = 'invalid_path' | 'not_found';

/**
 * 拒否の内部的な理由(単体テストと、コードを読む人のためのもの)
 *
 * **API の応答とログには出さない。** 出すと、秘密ファイルが存在するかどうかを
 * 応答の違いから調べられてしまう。
 */
export type RepoAccessReason =
  | 'malformed'
  | 'traversal'
  | 'absolute'
  | 'secret'
  | 'ignored'
  | 'outside'
  | 'missing'
  | 'not_a_file'
  | 'not_a_directory'
  | 'changed';

/** 応答に載せてよい、固定のメッセージ(パスや理由の詳細を含めない) */
const ACCESS_MESSAGES: Readonly<Record<RepoAccessCode, string>> = {
  invalid_path: 'パスの形式が正しくありません',
  not_found: '見つかりません',
};

/**
 * パスを受け付けられないときのエラー
 *
 * メッセージは `code` ごとの固定の文字列で、受け取ったパス、実体のパス、
 * ファイルの中身を含まない(C-5)。
 */
export class RepoAccessError extends Error {
  /** 応答に出してよい分類 */
  readonly code: RepoAccessCode;
  /** 内部的な理由(応答とログには出さない) */
  readonly reason: RepoAccessReason;

  /**
   * @param code 応答に出してよい分類
   * @param reason 内部的な理由
   */
  constructor(code: RepoAccessCode, reason: RepoAccessReason) {
    super(ACCESS_MESSAGES[code]);
    this.name = 'RepoAccessError';
    this.code = code;
    this.reason = reason;
  }
}

/** 受け付けるパス全体の長さの上限(文字数) */
export const MAX_PATH_LENGTH = 4096;
/** 受け付けるパスの1要素の長さの上限(文字数) */
export const MAX_SEGMENT_LENGTH = 255;

/** 制御文字(NUL、改行、DEL など)。パスに含まれていたら受け付けない */
// eslint-disable-next-line no-control-regex -- 制御文字そのものを検出するための正規表現
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * パスの1要素(ファイル名・ディレクトリ名)として受け付けられるかを調べる
 *
 * `.`、`..`、空、区切り文字(`/`、`\`)や制御文字を含むもの、長すぎるものは受け付けない。
 *
 * @param name パスの1要素
 * @returns 受け付けられるなら true
 */
export function isValidSegment(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.length > MAX_SEGMENT_LENGTH) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  return !CONTROL_CHARS.test(name);
}

/**
 * 利用者が指定したリポジトリ相対パスを、要素の配列にする(S1-4 の文字列の検査)
 *
 * - `./` と、重複した `/`、末尾の `/` は取り除く(`./a//b/` は `['a', 'b']`)
 * - 空文字列は、リポジトリのルート(空の配列)
 * - 次のものは受け付けない: 絶対パス、`..` を含むもの(途中で打ち消し合う形も含む)、
 *   バックスラッシュ、NUL などの制御文字、長すぎるもの
 *
 * URL のデコードは、呼び出し側(HTTP の枠組み)が1回だけ済ませている前提。
 * ここでは追加のデコードをしない(`%2e%2e` という文字列は、その名前のファイルとして扱う)。
 *
 * @param input 利用者が指定したパス
 * @returns パスの要素の配列(ルートなら空)
 * @throws RepoAccessError 形式が正しくないとき(`invalid_path`)
 */
export function parseRepoPath(input: string): string[] {
  if (typeof input !== 'string') throw new RepoAccessError('invalid_path', 'malformed');
  if (input.length > MAX_PATH_LENGTH) throw new RepoAccessError('invalid_path', 'malformed');
  if (CONTROL_CHARS.test(input)) throw new RepoAccessError('invalid_path', 'malformed');
  // Linux ではバックスラッシュもファイル名に使えるが、区切り文字として解釈される環境との
  // 食い違いを突かれないように、一律に受け付けない
  if (input.includes('\\')) throw new RepoAccessError('invalid_path', 'malformed');
  if (input.startsWith('/')) throw new RepoAccessError('invalid_path', 'absolute');

  const segments: string[] = [];
  for (const part of input.split('/')) {
    if (part === '' || part === '.') continue;
    // `src/../a` のようにリポジトリの中に収まる形でも、`..` は一律に受け付けない
    // (正規化の順序の違いを突く回避パターンを、まとめて封じるため)
    if (part === '..') throw new RepoAccessError('invalid_path', 'traversal');
    if (!isValidSegment(part)) throw new RepoAccessError('invalid_path', 'malformed');
    segments.push(part);
  }
  return segments;
}

/** 秘密ファイルの判定規則(名前は小文字で書く) */
interface SecretRule {
  /** 比較の方法(完全一致、前方一致、後方一致) */
  readonly kind: 'exact' | 'prefix' | 'suffix';
  /** 比較する文字列(小文字) */
  readonly value: string;
}

/**
 * SPEC S1-5 が名前を挙げている秘密ファイルのパターン
 *
 * `.env*`、`.git/`、`*.pem`、`*.key`、`id_rsa*`、`credentials*`、`.claude.json`。
 * `.env.example` も、SPEC の文字どおり `.env*` に一致するので拒否する(暫定の方針)。
 */
export const SPEC_SECRET_RULES: readonly SecretRule[] = [
  { kind: 'prefix', value: '.env' },
  { kind: 'exact', value: '.git' },
  { kind: 'suffix', value: '.pem' },
  { kind: 'suffix', value: '.key' },
  { kind: 'prefix', value: 'id_rsa' },
  { kind: 'prefix', value: 'credentials' },
  { kind: 'exact', value: '.claude.json' },
];

/**
 * SPEC S1-5 の「など」にあたる、鍵や認証情報のファイル(Coder の仮定。報告に記載)
 *
 * SPEC が挙げた名前と同じ種類のもの(ほかの方式の SSH 秘密鍵、証明書の束、
 * 認証情報を持つ設定ファイルとディレクトリ)に限っている。
 */
export const EXTRA_SECRET_RULES: readonly SecretRule[] = [
  { kind: 'prefix', value: 'id_dsa' },
  { kind: 'prefix', value: 'id_ecdsa' },
  { kind: 'prefix', value: 'id_ed25519' },
  { kind: 'suffix', value: '.p12' },
  { kind: 'suffix', value: '.pfx' },
  { kind: 'exact', value: '.netrc' },
  { kind: 'exact', value: '.npmrc' },
  { kind: 'exact', value: '.pgpass' },
  { kind: 'exact', value: '.ssh' },
  { kind: 'exact', value: '.aws' },
  { kind: 'exact', value: '.gnupg' },
];

/** 判定に使う、すべての規則 */
const SECRET_RULES: readonly SecretRule[] = [...SPEC_SECRET_RULES, ...EXTRA_SECRET_RULES];

/**
 * 小文字に揃えた名前が、秘密ファイルの規則のどれかに一致するかを調べる
 *
 * @param lowered 小文字に揃えた、パスの1要素
 * @returns 一致すれば true
 */
function matchesSecretRule(lowered: string): boolean {
  return SECRET_RULES.some((rule) => {
    if (rule.kind === 'exact') return lowered === rule.value;
    if (rule.kind === 'prefix') return lowered.startsWith(rule.value);
    return lowered.endsWith(rule.value);
  });
}

/**
 * パスの1要素(ファイル名・ディレクトリ名)が、秘密ファイルの名前かどうかを調べる(S1-5)
 *
 * 大文字小文字は区別しない(`.ENV`、`ID_RSA`)。全角などの互換文字を使った書き方と、
 * 末尾に `.` や空白を足した書き方(大文字小文字を区別しないファイルシステムや、
 * 末尾の `.` を無視するファイルシステムで同じファイルを指す)も、同じ名前として判定する。
 *
 * @param name パスの1要素
 * @returns 秘密ファイルの名前なら true
 */
export function isSecretName(name: string): boolean {
  const lowered = name.toLowerCase();
  if (matchesSecretRule(lowered)) return true;
  const folded = name.normalize('NFKC').toLowerCase().replace(/[. ]+$/, '');
  return folded !== lowered && matchesSecretRule(folded);
}

/**
 * パスのどこかの要素が、秘密ファイルの名前かどうかを調べる(S1-5)
 *
 * 途中の要素も調べるので、`.git/config` や `sub/.env`、`credentials/x` も対象になる。
 *
 * @param segments パスの要素の配列
 * @returns 秘密ファイル(または、その配下)なら true
 */
export function hasSecretSegment(segments: readonly string[]): boolean {
  return segments.some((segment) => isSecretName(segment));
}
