import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { expandHomePath, readOptionalEnv, resolveHomeDir } from "@kato/runtime";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";
import { resolveTestTempPath } from "./test_temp.ts";

const RUNTIME_ENV_HOME = resolveTestTempPath("runtime-home");

async function withRuntimeEnvTest(
  run: () => Promise<void> | void,
): Promise<void> {
  await withLockedEnvironment(async () => {
    const snapshot = snapshotRuntimeEnv();
    try {
      await run();
    } finally {
      restoreRuntimeEnv(snapshot);
    }
  });
}

Deno.test("readOptionalEnv returns undefined when the variable is missing", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: undefined });
    assertEquals(readOptionalEnv("HOME"), undefined);
  });
});

Deno.test("readOptionalEnv returns undefined for empty values", async () => {
  await withRuntimeEnvTest(() => {
    Deno.env.set("HOME", "");
    assertEquals(readOptionalEnv("HOME"), undefined);
  });
});

Deno.test("readOptionalEnv returns non-empty values", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: RUNTIME_ENV_HOME });
    assertEquals(readOptionalEnv("HOME"), RUNTIME_ENV_HOME);
  });
});

Deno.test("resolveHomeDir prefers HOME over USERPROFILE", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({
      HOME: RUNTIME_ENV_HOME,
      USERPROFILE: "C:\\Users\\runtime",
    });

    assertEquals(resolveHomeDir(), RUNTIME_ENV_HOME);
  });
});

Deno.test("resolveHomeDir falls back to USERPROFILE", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({
      HOME: undefined,
      USERPROFILE: "C:\\Users\\runtime",
    });

    assertEquals(resolveHomeDir(), "C:\\Users\\runtime");
  });
});

Deno.test("resolveHomeDir returns undefined when neither home variable is available", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({
      HOME: undefined,
      USERPROFILE: undefined,
    });

    assertEquals(resolveHomeDir(), undefined);
  });
});

Deno.test("expandHomePath leaves non-home-prefixed paths unchanged", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: RUNTIME_ENV_HOME });
    assertEquals(
      expandHomePath(join(RUNTIME_ENV_HOME, "projects")),
      join(RUNTIME_ENV_HOME, "projects"),
    );
  });
});

Deno.test("expandHomePath expands a bare tilde to the resolved home directory", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: RUNTIME_ENV_HOME });
    assertEquals(expandHomePath("~"), RUNTIME_ENV_HOME);
  });
});

Deno.test("expandHomePath expands forward-slash child paths", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: RUNTIME_ENV_HOME });
    assertEquals(
      expandHomePath("~/projects/current"),
      join(RUNTIME_ENV_HOME, "projects/current"),
    );
  });
});

Deno.test("expandHomePath expands backslash child paths", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: RUNTIME_ENV_HOME });
    assertEquals(
      expandHomePath("~\\projects\\current"),
      join(RUNTIME_ENV_HOME, "projects\\current"),
    );
  });
});

Deno.test("expandHomePath leaves named-user tildes unchanged", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: RUNTIME_ENV_HOME });
    assertEquals(expandHomePath("~another/projects"), "~another/projects");
  });
});

Deno.test("expandHomePath leaves home-prefixed paths unchanged when no home directory is available", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({
      HOME: undefined,
      USERPROFILE: undefined,
    });

    assertEquals(expandHomePath("~/projects/current"), "~/projects/current");
  });
});
