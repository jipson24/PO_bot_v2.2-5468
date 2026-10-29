import { base } from "../__core/app";
import { readNewsShadowStatus } from "../news/engine";

/** Только чтение теневого журнала: UI не запускает движок и не меняет веса. */
export const news = { overview: base.handler(() => readNewsShadowStatus()) };