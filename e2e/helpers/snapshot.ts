/**
 * ディレクトリの内容の記録と比較(S2-8: 対象リポジトリが操作の前後で変わらないことの確認)
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * ディレクトリの下のすべてのエントリについて、種類と内容のハッシュを記録する
 * (シンボリックリンクはたどらず、リンク先の文字列を記録する)
 *
 * @param root 記録するディレクトリ
 * @returns 相対パス(`/` 区切り)から、`file:<SHA-256>`、`dir`、`link:<リンク先>` への対応
 */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  /**
   * 再帰的にたどる
   * @param rel root からの相対パス('' は root 自身)
   * @returns なし
   */
  const walk = async (rel: string): Promise<void> => {
    const full = rel === '' ? root : join(root, rel);
    for (const name of (await readdir(full)).sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const childFull = join(root, childRel);
      const st = await lstat(childFull);
      if (st.isSymbolicLink()) {
        result[childRel] = `link:${await readlink(childFull)}`;
      } else if (st.isDirectory()) {
        result[childRel] = 'dir';
        await walk(childRel);
      } else {
        result[childRel] = `file:${createHash('sha256').update(await readFile(childFull)).digest('hex')}`;
      }
    }
  };
  await walk('');
  return result;
}
