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

type SliceName = "test:parallel-safe" | "test:env";

type SliceCommand = {
  name: SliceName;
  args: string[];
};

type TestSummary = {
  status: "ok" | "FAILED";
  passed: number;
  failed: number;
  ignored: number;
  measured: number;
  filtered: number;
  duration: string;
};

function buildCommands(mode: Mode, forwardedArgs: string[]): SliceCommand[] {
  const coverageArgs = mode === "coverage"
    ? ["--clean", "--coverage=.test-tmp/coverage/root"]
    : [];
  const envCoverageArgs = mode === "coverage"
    ? ["--coverage=.test-tmp/coverage/root"]
    : [];

  return [
    {
      name: "test:parallel-safe",
      args: [
        "test",
        ...SHARED_TEST_ARGS,
        ...coverageArgs,
        "--parallel",
        `--ignore=${ENV_TEST_FILES.join(",")}`,
        "tests",
        ...forwardedArgs,
      ],
    },
    {
      name: "test:env",
      args: [
        "test",
        ...SHARED_TEST_ARGS,
        ...envCoverageArgs,
        ...ENV_TEST_FILES,
        ...forwardedArgs,
      ],
    },
  ];
}

function parseTestSummary(line: string): TestSummary | undefined {
  const match = /^(ok|FAILED)\s+\|\s+(.+)\s+\(([^)]+)\)$/.exec(
    sanitizeTerminalText(line).trim(),
  );
  if (!match) {
    return undefined;
  }

  const [, status, summaryParts, duration] = match;
  const summary: TestSummary = {
    status: status as TestSummary["status"],
    passed: 0,
    failed: 0,
    ignored: 0,
    measured: 0,
    filtered: 0,
    duration,
  };

  for (const part of summaryParts.split(" | ")) {
    const countMatch = /^(\d+)\s+(passed|failed|ignored|measured|filtered out)$/
      .exec(part.trim());
    if (!countMatch) {
      continue;
    }
    const count = Number(countMatch[1]);
    const label = countMatch[2];
    switch (label) {
      case "passed":
        summary.passed = count;
        break;
      case "failed":
        summary.failed = count;
        break;
      case "ignored":
        summary.ignored = count;
        break;
      case "measured":
        summary.measured = count;
        break;
      case "filtered out":
        summary.filtered = count;
        break;
    }
  }

  return summary;
}

function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, "");
}

function findSummaryInTranscript(transcript: string): TestSummary | undefined {
  const lines = sanitizeTerminalText(transcript)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const summary = parseTestSummary(lines[index]);
    if (summary) {
      return summary;
    }
  }

  return undefined;
}

async function scanLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    pending += value;
    while (true) {
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
      pending = pending.slice(newlineIndex + 1);
      onLine(line);
    }
  }

  if (pending.length > 0) {
    onLine(pending.replace(/\r$/, ""));
  }
}

function formatSummary(summary: TestSummary): string {
  const parts = [
    `${summary.passed} passed`,
    `${summary.failed} failed`,
  ];
  if (summary.ignored > 0) {
    parts.push(`${summary.ignored} ignored`);
  }
  if (summary.measured > 0) {
    parts.push(`${summary.measured} measured`);
  }
  if (summary.filtered > 0) {
    parts.push(`${summary.filtered} filtered out`);
  }
  return `${summary.status} | ${parts.join(" | ")} (${summary.duration})`;
}

function mergeSummaries(summaries: TestSummary[]): TestSummary {
  return summaries.reduce<TestSummary>(
    (combined, summary) => ({
      status: combined.failed + summary.failed > 0 ? "FAILED" : "ok",
      passed: combined.passed + summary.passed,
      failed: combined.failed + summary.failed,
      ignored: combined.ignored + summary.ignored,
      measured: combined.measured + summary.measured,
      filtered: combined.filtered + summary.filtered,
      duration: "combined",
    }),
    {
      status: "ok",
      passed: 0,
      failed: 0,
      ignored: 0,
      measured: 0,
      filtered: 0,
      duration: "combined",
    },
  );
}

async function runCommand(
  slice: SliceCommand,
): Promise<TestSummary | undefined> {
  console.log(`\n==> Running ${slice.name}`);

  const command = new Deno.Command(Deno.execPath(), {
    args: slice.args,
    stdin: "inherit",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();

  let summary: TestSummary | undefined;
  let transcript = "";
  const stdoutReader = child.stdout.tee();
  const stderrReader = child.stderr.tee();

  const stdoutPump = stdoutReader[0].pipeTo(Deno.stdout.writable, {
    preventClose: true,
  });
  const stderrPump = stderrReader[0].pipeTo(Deno.stderr.writable, {
    preventClose: true,
  });
  const stdoutScan = scanLines(stdoutReader[1], (line) => {
    transcript += `${line}\n`;
    const parsed = parseTestSummary(line);
    if (parsed) {
      summary = parsed;
    }
  });
  const stderrScan = scanLines(stderrReader[1], (line) => {
    transcript += `${line}\n`;
    const parsed = parseTestSummary(line);
    if (parsed) {
      summary = parsed;
    }
  });

  const [{ code }] = await Promise.all([
    child.status,
    stdoutPump,
    stderrPump,
    stdoutScan,
    stderrScan,
  ]);

  summary ??= findSummaryInTranscript(transcript);

  if (summary) {
    console.log(`==> ${slice.name} summary: ${formatSummary(summary)}`);
  } else {
    console.log(`==> ${slice.name} finished with exit code ${code}`);
  }

  if (code !== 0) {
    Deno.exit(code);
  }

  return summary;
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
  const summaries: TestSummary[] = [];
  for (const slice of commands) {
    const summary = await runCommand(slice);
    if (summary) {
      summaries.push(summary);
    }
  }

  if (summaries.length > 0) {
    const combined = mergeSummaries(summaries);
    console.log(`\n==> Combined root test summary: ${formatSummary(combined)}`);
  }
}

await main();
