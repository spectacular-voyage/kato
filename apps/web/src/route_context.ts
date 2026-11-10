// The request context Kato Web's page modules (apps/web/pages) depend on,
// instead of a framework's own context type. Adapters build it from the
// framework in use (see task.2026.2026-11-10-leave-fresh). Kept free of JSX
// and Preact so the root config can type-check it with the rest of src/.

export interface RouteState {
  appName: string;
  authenticated: boolean;
  csrfToken?: string;
  pathname: string;
}

export interface RouteContext {
  req: Request;
  url: URL;
  params: Record<string, string>;
  state: RouteState;
}

export type RouteHandler = (
  ctx: RouteContext,
) => Response | Promise<Response>;
