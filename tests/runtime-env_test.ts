import { assertEquals } from "@std/assert";
import { expandHomePath, readOptionalEnv, resolveHomeDir } from "@kato/runtime";
import {
  restoreRuntimeEnv,
  setRuntimeEnv,
  snapshotRuntimeEnv,
  withLockedEnvironment,
} from "./test_env.ts";

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
    setRuntimeEnv({ HOME: "/tmp/runtime-home" });
    assertEquals(readOptionalEnv("HOME"), "/tmp/runtime-home");
  });
});

Deno.test("resolveHomeDir prefers HOME over USERPROFILE", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({
      HOME: "/tmp/runtime-home",
      USERPROFILE: "C:\\Users\\runtime",
    });

    assertEquals(resolveHomeDir(), "/tmp/runtime-home");
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
    setRuntimeEnv({ HOME: "/tmp/runtime-home" });
    assertEquals(
      expandHomePath("/tmp/runtime-home/projects"),
      "/tmp/runtime-home/projects",
    );
  });
});

Deno.test("expandHomePath expands a bare tilde to the resolved home directory", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: "/tmp/runtime-home" });
    assertEquals(expandHomePath("~"), "/tmp/runtime-home");
  });
});

Deno.test("expandHomePath expands forward-slash child paths", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: "/tmp/runtime-home" });
    assertEquals(
      expandHomePath("~/projects/current"),
      "/tmp/runtime-home/projects/current",
    );
  });
});

Deno.test("expandHomePath expands backslash child paths", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: "/tmp/runtime-home" });
    assertEquals(
      expandHomePath("~\\projects\\current"),
      "/tmp/runtime-home/projects\\current",
    );
  });
});

Deno.test("expandHomePath leaves named-user tildes unchanged", async () => {
  await withRuntimeEnvTest(() => {
    setRuntimeEnv({ HOME: "/tmp/runtime-home" });
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
