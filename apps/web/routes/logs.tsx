// Fresh entry point; the page lives in apps/web/pages (see fresh_adapter.tsx).
import { freshPage } from "../fresh_adapter.tsx";
import { define } from "../utils.ts";
import * as route from "../pages/logs.tsx";

export default define.page(freshPage(route.page));
