const ENV_TEST_FILES = [
  "tests/daemon-cli_test.ts",
  "tests/daemon-control-plane_test.ts",
  "tests/daemon-launcher_test.ts",
  "tests/daemon-main_test.ts",
  "tests/executable-resolution_test.ts",
  "tests/participant-username-resolver_test.ts",
  "tests/path-policy_test.ts",
  "tests/runtime-config_test.ts",
  "tests/runtime-env_test.ts",
  "tests/test_env_test.ts",
  "tests/web-cli_test.ts",
] as const;

const SHARED_TEST_ARGS = [
  "--allow-read",
  "--allow-write=.test-tmp",
  "--allow-run",
  "--allow-env=KATO_LOGGING_OPERATIONAL_LEVEL,KATO_LOGGING_AUDIT_LEVEL,HOME,USERPROFILE,KATO_RUNTIME_DIR,KATO_DAEMON_STATUS_PATH,KATO_DAEMON_CONTROL_PATH,KATO_CLAUDE_SESSION_ROOTS,KATO_CODEX_SESSION_ROOTS,KATO_GEMINI_SESSION_ROOTS,KATO_DAEMON_MAX_MEMORY_MB,KATO_CONFIG_PATH,KATO_ALLOWED_WRITE_ROOT,KATO_ALLOWED_WRITE_ROOTS_JSON,KATO_WEB_PASSWORD",
] as const;

type Mode = "standard" | "coverage";

function buildCommands(mode: Mode, forwardedArgs: string[]): string[][] {
  const coverageArgs = mode === "coverage"
    ? ["--clean", "--coverage=.test-tmp/coverage/root"]
    : [];
  const envCoverageArgs = mode === "coverage"
    ? ["--coverage=.test-tmp/coverage/root"]
    : [];

  return [
    [
      "test",
      ...SHARED_TEST_ARGS,
      ...coverageArgs,
      "--parallel",
      `--ignore=${ENV_TEST_FILES.join(",")}`,
      "tests",
      ...forwardedArgs,
    ],
    [
      "test",
      ...SHARED_TEST_ARGS,
      ...envCoverageArgs,
      ...ENV_TEST_FILES,
      ...forwardedArgs,
    ],
  ];
}

async function runCommand(args: string[]): Promise<void> {
  const command = new Deno.Command(Deno.execPath(), {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await command.output();
  if (code !== 0) {
    Deno.exit(code);
  }
}

async function main(): Promise<void> {
  const [mode, ...forwardedArgs] = Deno.args;
  if (mode !== "standard" && mode !== "coverage") {
    console.error(
      "usage: deno run -A scripts/run-root-test-slices.ts <standard|coverage> [deno test args...]",
    );
    Deno.exit(2);
  }

  const commands = buildCommands(mode, forwardedArgs);
  for (const args of commands) {
    await runCommand(args);
  }
}

await main();
