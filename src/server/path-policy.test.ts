/**
 * T1-2: パスの検証と、秘密ファイルの判定の単体テスト(S1-4、S1-5)
 *
 * セキュリティ基準の回帰テスト。機能追加のときに外さない。
 */
import { describe, expect, it } from 'vitest';
import {
  hasSecretSegment,
  isSecretName,
  isValidSegment,
  MAX_PATH_LENGTH,
  MAX_SEGMENT_LENGTH,
  parseRepoPath,
  RepoAccessError,
} from './path-policy.js';

/**
 * parseRepoPath が投げたエラーを取り出す
 *
 * @param input 検証するパス
 * @returns 投げられた RepoAccessError(投げられなければ、テストを失敗させる)
 */
function rejection(input: string): RepoAccessError {
  try {
    parseRepoPath(input);
  } catch (err) {
    if (err instanceof RepoAccessError) return err;
    throw err;
  }
  throw new Error(`拒否されなかった: ${JSON.stringify(input)}`);
}

describe('S1-4: parseRepoPath は、リポジトリの中の相対パスを要素に分ける', () => {
  it.each<[string, string[]]>([
    ['', []],
    ['.', []],
    ['./', []],
    ['src', ['src']],
    ['src/example.ts', ['src', 'example.ts']],
    ['./src/example.ts', ['src', 'example.ts']],
    ['src//example.ts', ['src', 'example.ts']],
    ['src/./example.ts', ['src', 'example.ts']],
    ['src/', ['src']],
    ['reports/2026-10-12-feature.md', ['reports', '2026-10-12-feature.md']],
    ['日本語/ファイル 名.md', ['日本語', 'ファイル 名.md']],
    ['a..b/..c/d..', ['a..b', '..c', 'd..']],
    ['...', ['...']],
  ])('S1-4: %j → %j', (input, expected) => {
    expect(parseRepoPath(input)).toEqual(expected);
  });

  it('S1-4: URL のデコードはしない(エンコードされたままの文字列は、その名前のファイルとして扱う)', () => {
    // HTTP の枠組みが1回デコードした後の値を受け取る。二重エンコードは、ここに %2e%2e%2f として届く
    expect(parseRepoPath('%2e%2e%2foutside-secret.txt')).toEqual(['%2e%2e%2foutside-secret.txt']);
  });
});

describe('S1-4: parseRepoPath は、リポジトリの外を指しうるパスを拒否する', () => {
  it.each([
    '..',
    '../',
    '../outside-secret.txt',
    './../outside-secret.txt',
    'src/../../outside-secret.txt',
    'no-such-dir/../../outside-secret.txt',
    '../../../../../../../../etc/passwd',
    'src/..',
    'src/../..',
    // リポジトリの中に収まる形でも、`..` は一律に拒否する
    'src/../src/example.ts',
    '.git/../.env',
    'subdir//../.env',
  ])('S1-4: `..` を含む %j を拒否する', (input) => {
    const err = rejection(input);
    expect(err.code).toBe('invalid_path');
    expect(err.reason).toBe('traversal');
  });

  it.each(['/etc/passwd', '//etc/passwd', '/', '/repo/src/example.ts'])(
    'S1-4: 絶対パス %j を拒否する',
    (input) => {
      const err = rejection(input);
      expect(err.code).toBe('invalid_path');
      expect(err.reason).toBe('absolute');
    }
  );

  it.each([
    ['バックスラッシュ', '..\\outside-secret.txt'],
    ['バックスラッシュ(途中)', 'src\\example.ts'],
    ['バックスラッシュで始まる', '\\etc\\passwd'],
    ['NUL', '../outside-secret.txt\u0000.md'],
    ['NUL(秘密ファイルの後ろ)', '.env\u0000.md'],
    ['改行', 'src/exa\nmple.ts'],
    ['タブ', 'src/exa\tmple.ts'],
    ['DEL', 'src/exa\u007fmple.ts'],
  ])('S1-4: %s を含むパスを拒否する', (_label, input) => {
    expect(rejection(input).code).toBe('invalid_path');
  });

  it('S1-4: 長すぎるパスと、長すぎる要素を拒否する', () => {
    expect(rejection('a/'.repeat(MAX_PATH_LENGTH)).code).toBe('invalid_path');
    expect(rejection('a'.repeat(MAX_SEGMENT_LENGTH + 1)).code).toBe('invalid_path');
    expect(parseRepoPath('a'.repeat(MAX_SEGMENT_LENGTH))).toHaveLength(1);
  });

  it('C-5: エラーのメッセージに、受け取ったパスを含めない', () => {
    const err = rejection('../SENTINEL-PATH-MUST-NOT-APPEAR');
    expect(err.message).not.toContain('SENTINEL');
    expect(String(err)).not.toContain('SENTINEL');
  });
});

describe('S1-4: isValidSegment', () => {
  it.each(['a', '.gitignore', 'a b', '日本語', '..a'])('S1-4: %j は受け付ける', (name) => {
    expect(isValidSegment(name)).toBe(true);
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\u0000b', 'a\nb'])('S1-4: %j は受け付けない', (name) => {
    expect(isValidSegment(name)).toBe(false);
  });
});

describe('S1-5: isSecretName は、秘密ファイルの名前を判定する', () => {
  it.each([
    // .env*
    '.env',
    '.env.local',
    '.env.production',
    '.env.example',
    '.envrc',
    // .git/
    '.git',
    // *.pem、*.key
    'secret.pem',
    'server.key',
    'private.key',
    '.pem',
    // id_rsa*
    'id_rsa',
    'id_rsa.pub',
    'id_rsa_backup',
    // credentials*
    'credentials',
    'credentials.json',
    'credentials-prod.yaml',
    // .claude.json
    '.claude.json',
  ])('S1-5: %j は秘密(SPEC が挙げたパターン)', (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each(['id_dsa', 'id_ecdsa.pub', 'id_ed25519', 'cert.p12', 'cert.pfx', '.netrc', '.npmrc', '.pgpass', '.ssh', '.aws', '.gnupg'])(
    'S1-5: %j は秘密(「など」にあたる、鍵や認証情報のファイル)',
    (name) => {
      expect(isSecretName(name)).toBe(true);
    }
  );

  it.each([
    ['大文字', '.ENV'],
    ['大文字小文字の混在', '.Env.Local'],
    ['大文字', '.GIT'],
    ['大文字', 'SERVER.KEY'],
    ['大文字', 'Secret.PEM'],
    ['大文字', 'ID_RSA'],
    ['大文字', 'Credentials.JSON'],
    ['大文字', '.Claude.Json'],
    ['全角の互換文字', '.env'],
    ['末尾の .', '.git.'],
    ['末尾の空白', 'server.key '],
    ['末尾の . と空白', 'secret.pem. .'],
  ])('S1-5: 書き方を変えても秘密と判定する(%s: %j)', (_label, name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each([
    'example.ts',
    'README.md',
    '.gitignore',
    '.gitattributes',
    '.github',
    '.gitkeep',
    'env',
    'my.env.txt',
    'keys.ts',
    'key',
    'monkey',
    'pem.md',
    'my_id_rsa',
    'my-credentials',
    'claude.json',
    '.claude',
    'environment.ts',
  ])('S1-5: %j は秘密ではない(誤って拒否しない)', (name) => {
    expect(isSecretName(name)).toBe(false);
  });
});

describe('S1-5: hasSecretSegment は、途中の要素も調べる', () => {
  it.each<[string[]]>([
    [['.env']],
    [['subdir', '.env']],
    [['.git', 'config']],
    [['.git', 'HEAD']],
    [['subdir', 'nested', 'private.key']],
    [['credentials', 'readme.txt']],
    [['a', '.GIT', 'objects', 'x']],
    [['.claude', 'credentials.json']],
  ])('S1-5: %j は秘密', (segments) => {
    expect(hasSecretSegment(segments)).toBe(true);
  });

  it.each<[string[]]>([[[]], [['src', 'example.ts']], [['.github', 'workflows', 'ci.yml']], [['.gitignore']]])(
    'S1-5: %j は秘密ではない',
    (segments) => {
      expect(hasSecretSegment(segments)).toBe(false);
    }
  );
});
