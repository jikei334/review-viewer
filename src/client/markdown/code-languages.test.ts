/**
 * T1-3: コードブロックの言語の抽出の単体テスト
 */
import { describe, expect, it } from 'vitest';
import { extractCodeLanguages } from './code-languages.js';

describe('extractCodeLanguages', () => {
  it('S1-2: フェンスの言語を、出現順・重複なしで返す', () => {
    const md = '```typescript\na\n```\n\n```json\n{}\n```\n\n```typescript\nb\n```\n';
    expect(extractCodeLanguages(md)).toEqual(['typescript', 'json']);
  });

  it('S1-2: 言語なしのブロックと、インラインコードは対象にしない', () => {
    expect(extractCodeLanguages('```\nplain\n```\n\n`inline`')).toEqual([]);
  });

  it('S1-3: mermaid は除く(図として描画するため)', () => {
    expect(extractCodeLanguages('```mermaid\ngraph TD\n```\n\n```ts\nx\n```')).toEqual(['ts']);
  });

  it('S1-2: 言語名は小文字にそろえ、情報文字列の最初の単語だけを使う', () => {
    expect(extractCodeLanguages('```TypeScript title="a.ts"\nx\n```')).toEqual(['typescript']);
  });

  it('S1-2: 引用・リストの中のフェンスも拾う', () => {
    const md = '> ```rust\n> fn main() {}\n> ```\n\n- item\n\n  ```bash\n  ls\n  ```\n';
    expect(extractCodeLanguages(md)).toEqual(['rust', 'bash']);
  });

  it('S1-2: 空の文書は空の一覧', () => {
    expect(extractCodeLanguages('')).toEqual([]);
  });
});
