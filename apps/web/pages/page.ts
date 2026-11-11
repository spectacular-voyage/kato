import type { VNode } from "preact";
import type { RouteContext } from "../src/route_context.ts";

/**
 * What a page module returns: its data is already loaded, so `body` renders
 * synchronously. Without a `title`, the layout's "Kato Web" is used.
 */
export interface PageResult {
  title?: string;
  body: VNode;
}

export type PageHandler = (ctx: RouteContext) => Promise<PageResult>;
