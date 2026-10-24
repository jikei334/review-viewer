/**
 * T2-2: 起動時の引数の解析の単体テスト(SPEC §2.5、S2-9)
 */
import { describe, expect, it } from 'vitest';
import { LaunchArgsError, parseLaunchArgs } from './launch-args.js';

describe('S2-9: parseLaunchArgs', () => {
  it('S2-9: 引数が無ければ、位置引数も --data-dir も無い', () => {
    expect(parseLaunchArgs([])).toEqual({ positional: [], dataDir: undefined });
  });

  it('S2-9: 位置引数だけなら、対象リポジトリとして返す', () => {
    expect(parseLaunchArgs(['../repo'])).toEqual({ positional: ['../repo'], dataDir: undefined });
  });

  it('S2-9: --data-dir <パス> を位置引数と併用できる(順序を問わない)', () => {
    expect(parseLaunchArgs(['../repo', '--data-dir', '/d'])).toEqual({ positional: ['../repo'], dataDir: '/d' });
    expect(parseLaunchArgs(['--data-dir', '/d', '../repo'])).toEqual({ positional: ['../repo'], dataDir: '/d' });
  });

  it('S2-9: --data-dir=<パス> の形も受け付ける(値に = を含んでもよい)', () => {
    expect(parseLaunchArgs(['../repo', '--data-dir=/d'])).toEqual({ positional: ['../repo'], dataDir: '/d' });
    expect(parseLaunchArgs(['--data-dir=/a=b'])).toEqual({ positional: [], dataDir: '/a=b' });
  });

  it('S2-9: --data-dir の値を位置引数と取り違えない', () => {
    expect(parseLaunchArgs(['--data-dir', 'rel-data']).positional).toEqual([]);
  });

  it('S2-9: 単独の -- の後ろは、-- で始まるものも位置引数として扱う', () => {
    expect(parseLaunchArgs(['--', '--weird'])).toEqual({ positional: ['--weird'], dataDir: undefined });
  });

  it.each([
    ['値が無い', ['--data-dir']],
    ['値が別のオプション', ['--data-dir', '--other']],
    ['= の後ろが空', ['--data-dir=']],
    ['値が空白だけ', ['--data-dir', '  ']],
    ['重複', ['--data-dir', '/a', '--data-dir=/b']],
    ['未知のオプション', ['--unknown']],
    ['未知のオプション(= つき)', ['--unknown=1']],
  ])('S2-9: %s はエラーにする(黙って無視しない)', (_label, args) => {
    expect(() => parseLaunchArgs(args)).toThrow(LaunchArgsError);
  });

  it('C-5: 未知のオプションのエラーに、= の後ろの値を含めない', () => {
    expect(() => parseLaunchArgs(['--token=SECRET_VALUE'])).toThrow(/--token/);
    try {
      parseLaunchArgs(['--token=SECRET_VALUE']);
    } catch (err: unknown) {
      expect((err as Error).message).not.toContain('SECRET_VALUE');
    }
  });
});
