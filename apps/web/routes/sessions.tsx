// Fresh entry point; the page lives in apps/web/pages (see fresh_adapter.tsx).
import { freshHandler, freshPage } from "../fresh_adapter.tsx";
import { define } from "../utils.ts";
import * as route from "../pages/sessions.tsx";

export const handler = define.handlers({ POST: freshHandler(route.POST) });

export default define.page(freshPage(route.page));
