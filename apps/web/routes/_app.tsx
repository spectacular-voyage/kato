import { define } from "../utils.ts";

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
      <body>
        <Component />
      </body>
    </html>
  );
});
