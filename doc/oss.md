# 使用 OSS 一覧

このプロジェクトが直接依存している OSS の一覧。`package.json` に書いたものだけを載せる(間接的な依存は `package-lock.json` を参照)。

- バージョンは、`package.json` で固定している値
- ライセンスは、インストールした実物(`node_modules/<パッケージ>/package.json` の `license`)で確認した値
- 依存を追加・更新したら、この表も更新する

## 開発時の依存(devDependencies)

| OSS 名 | バージョン | ライセンス | 用途 |
|---|---|---|---|
| typescript | 6.0.3 | Apache-2.0 | TypeScript コンパイラ(型検査、サーバーのビルド) |
| vite | 8.3.4 | MIT | 画面のビルドと開発サーバー |
| vitest | 4.1.11 | MIT | 単体テスト(`npm run test`)とシステムテスト(`npm run e2e`)の実行 |
| eslint | 10.12.0 | MIT | Linter |
| @eslint/js | 10.0.1 | MIT | ESLint の JavaScript 用の推奨ルール |
| typescript-eslint | 8.71.1 | MIT | ESLint の TypeScript 対応(パーサーと推奨ルール) |
| @types/node | 22.20.5 | MIT | Node.js の型定義(対象の下限である Node.js 22 系に合わせている) |

## 実行時の依存(dependencies)

| OSS 名 | バージョン | ライセンス | 用途 |
|---|---|---|---|
| hono | 4.13.13 | MIT | Web サーバーのフレームワーク(ルーティング、ミドルウェア) |
| @hono/node-server | 2.1.4 | MIT | Node.js の HTTP サーバーで Hono を動かすアダプタ |
| ignore | 7.0.12 | MIT | `.gitignore` のパターンの判定(S1-5。除外されたファイルを一覧に出さず、取得も拒否するため。自前で実装しない) |

画面(React など)のライブラリは、それを使うタスクで追加する。

## 最新版を使っていないもの

| OSS 名 | 最新版(2026-10-12 時点) | 採用した版 | 理由 |
|---|---|---|---|
| typescript | 7.0.2 | 6.0.3 | typescript-eslint 8.71.1 が対応する TypeScript は `>=4.8.4 <6.1.0`。7 系には未対応 |
| vitest | 5.0.3 | 4.1.11 | T1-N1 で 5.0.3 を試した結果、上げる条件を満たさなかった(下の「vitest 5 を見送った理由」を参照)。Node.js の版は理由ではなくなった |
| @types/node | 26.6.5 | 22.20.5 | 対象の下限は Node.js 22 系。22 に無い API を、型検査で誤って通さないため(22 系の中では最新) |

### vitest 5 を見送った理由(T1-N1、2026-10-12)

対象の Node.js を 22 以上に上げたので(`engines.node` は `^22.13.0 || >=24`)、vitest 5.0.3 を実際に入れて確かめた。`npm run check` は通り(583 件)、`npm run e2e` の件数と成否も変わらなかった(166 passed / 15 todo / 失敗 0)。それでも、次の点が残るので 4.1.11 に留めた。

- **システムテストの名前が 38 件変わる。** vitest 5 は、`it.each` のタイトルの `$` 変数に入る文字列から引用符を外す(リリースノートの破壊的変更 #10170)。`e2e/api.test.ts` の S1-5 の 38 件が該当する(例: `GET /api/file は '.env' を拒否する('.env*')` が `GET /api/file は .env を拒否する(.env*)` になる)。名前を元に戻すには `e2e/` の変更が要るが、`e2e/` は Tester の担当
- **`-t` の照合の仕方が変わる。** `describe` とテストの名前を、空白ではなく ` > ` でつないだ文字列に照合する(#10686)。基準 ID だけの指定(`-t S1-4`、`-t S1-5`、`-t C-1`)は、4 系と同じ件数になることを確かめた。`describe` とテストの名前にまたがる指定は、結果が変わる
- **対応する Node.js の範囲が違う。** vitest 5.0.3 の `engines.node` は `^22.12.0 || ^24.0.0 || >=26.0.0` で、25 系が入らない。上げるなら、`engines.node` を `^22.13.0 || ^24.0.0 || >=26.0.0` に狭める必要がある
- 既定値の変更(`clearMocks` が既定で有効: #10613)は、`vi.fn` を使う単体テストに関係する。現在のテストは、そのままで通ることを確かめた

出典: vitest の移行ガイド(https://vitest.dev/guide/migration.html)、v5.0.0 のリリースノート(https://github.com/vitest-dev/vitest/releases/tag/v5.0.0)、レジストリの `vitest@5.0.3` の `engines` と `peerDependencies`。上げるかどうかは、Tester と人間の判断に委ねる。
