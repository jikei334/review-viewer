/**
 * Markdown から作った HTML(hast)の無害化の設定(S1-7)
 *
 * rehype-sanitize の既定(GitHub と同じ規則)をもとにする。既定は、script・iframe・object・embed・
 * form・style・meta・link などの要素と、`on*` のイベントハンドラ属性、`javascript:` などの
 * URL を取り除く。そこに、タスクリストのチェック状態(`checked`)だけを足す。
 */
import { defaultSchema } from 'rehype-sanitize';
import type { Options as SanitizeSchema } from 'rehype-sanitize';

/**
 * 無害化の設定を作る
 *
 * 既定の `input` の許可属性は `disabled` と `type=checkbox` だけで、GFM のタスクリストの
 * チェック済みの印(`checked`)が落ちてしまうため、`input` に限って `checked` を足す。
 *
 * @returns rehype-sanitize に渡す設定
 */
export function createSanitizeSchema(): SanitizeSchema {
  const attributes = defaultSchema.attributes ?? {};
  return {
    ...defaultSchema,
    attributes: {
      ...attributes,
      input: [...(attributes.input ?? []), 'checked'],
    },
  };
}

/** 無害化の設定(モジュールの読み込み時に1回だけ作る) */
export const SANITIZE_SCHEMA: SanitizeSchema = createSanitizeSchema();
