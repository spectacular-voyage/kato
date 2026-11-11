// Fresh entry point; the handlers live in apps/web/pages (see fresh_adapter.tsx).
import { freshHandler } from "../fresh_adapter.tsx";
import { define } from "../utils.ts";
import * as route from "../pages/logout.ts";

export const handler = define.handlers({
  GET: () => route.GET(),
  POST: freshHandler(route.POST),
});
