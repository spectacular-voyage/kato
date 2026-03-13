import { define } from "../utils.ts";
import { BRAND_ASSET_PUBLIC_PATHS } from "../src/brand_assets.ts";

export default define.page(function App({ Component, state }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <title>{state.appName}</title>
      </head>
      <body class="app-body">
        <main class="app-main">
          <Component />
        </main>
        <footer class="app-footer">
          {state.pathname !== "/login"
            ? (
              <img
                class="footer-wordmark"
                src={BRAND_ASSET_PUBLIC_PATHS.wordmark}
                alt="Kato"
                width="240"
                height="48"
              />
            )
            : null}
          <p class="footer-copy">
            © 2026{" "}
            <a
              class="footer-link"
              href="https://spectacular.voyage/"
              target="_blank"
              rel="noreferrer"
            >
              Spectacular Voyage LLC
            </a>
          </p>
        </footer>
      </body>
    </html>
  );
});
