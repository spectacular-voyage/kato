// Fresh adapters for the framework-free page modules in apps/web/pages. The
// files under routes/ stay as thin Fresh entry points until the cutover
// replaces Fresh (task.2026.2026-11-10-leave-fresh); this module goes with it.
import { Head } from "fresh/runtime";
import type { PageHandler } from "./pages/page.ts";
import type { RouteContext, RouteHandler } from "./src/route_context.ts";
import type { State } from "./utils.ts";

/** The parts of Fresh's route context the page modules use. */
interface FreshContextLike {
  req: Request;
  url: URL;
  params: Record<string, string>;
  state: State;
}

export function toRouteContext(ctx: FreshContextLike): RouteContext {
  return {
    req: ctx.req,
    url: ctx.url,
    params: ctx.params,
    state: ctx.state,
  };
}

export function freshHandler(handler: RouteHandler) {
  return (ctx: FreshContextLike) => handler(toRouteContext(ctx));
}

export function freshPage(page: PageHandler) {
  return async function FreshPage(ctx: FreshContextLike) {
    const result = await page(toRouteContext(ctx));
    return (
      <>
        {result.title !== undefined && (
          <Head>
            <title>{result.title}</title>
          </Head>
        )}
        {result.body}
      </>
    );
  };
}
