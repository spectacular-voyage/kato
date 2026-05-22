import { assertStringIncludes } from "jsr:@std/assert@1";
import { renderToString } from "npm:preact-render-to-string@6.6.6";
import { LoginForm } from "../routes/login.tsx";

Deno.test("login page autofocuses the username input", () => {
  const html = renderToString(<LoginForm error={false} />);

  assertStringIncludes(html, 'id="username"');
  assertStringIncludes(html, 'name="username"');
  assertStringIncludes(html, "autofocus");
});

Deno.test("login page shows error message when error is true", () => {
  const html = renderToString(<LoginForm error />);

  assertStringIncludes(html, 'class="danger"');
  assertStringIncludes(html, "Invalid username or password");
});
