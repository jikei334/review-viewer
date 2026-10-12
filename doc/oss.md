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
| @types/node | 20.19.43 | MIT | Node.js の型定義(Node.js 20 系に合わせている) |

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
| vitest | 5.0.3 | 4.1.11 | vitest 5 は Node.js 22.12 以上が必要。このプロジェクトは Node.js 20 を対象にしている |
| @types/node | 26.6.5 | 20.19.43 | Node.js 20 に無い API を、型検査で誤って通さないため |
