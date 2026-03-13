import { assertEquals, assertThrows } from "@std/assert";
import { CliUsageError, parseDaemonCliArgs } from "../apps/cli/src/mod.ts";

function parseCommand(args: string[]) {
  const intent = parseDaemonCliArgs(args);
  assertEquals(intent.kind, "command");
  if (intent.kind !== "command") {
    throw new Error("expected command intent");
  }
  return intent.command;
}

function assertHelpTopic(args: string[], topic?: string): void {
  const intent = parseDaemonCliArgs(args);
  assertEquals(intent.kind, "help");
  if (intent.kind !== "help") {
    throw new Error("expected help intent");
  }
  assertEquals(intent.topic, topic);
}

Deno.test("cli parser returns top-level help with no args", () => {
  assertHelpTopic([], undefined);
});

Deno.test("cli parser rejects --version with trailing args", () => {
  assertThrows(
    () => parseDaemonCliArgs(["--version", "extra"]),
    CliUsageError,
  );
});

Deno.test("cli parser resolves help topics and rejects invalid help usage", () => {
  assertHelpTopic(["help", "workspace-register"], "workspace-register");
  assertThrows(
    () => parseDaemonCliArgs(["help", "bogus"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["help", "status", "extra"]),
    CliUsageError,
  );
});

Deno.test("cli parser handles start restart init and stop help flags", () => {
  assertHelpTopic(["start", "--help"], "start");
  assertHelpTopic(["restart", "-h"], "restart");
  assertHelpTopic(["init", "--help"], "init");
  assertHelpTopic(["stop", "-h"], "stop");
});

Deno.test("cli parser parses workspace init optional dir and rejects extra args", () => {
  const command = parseCommand(["workspace", "init", "./notes"]);
  assertEquals(command, {
    name: "workspace-init",
    dirPath: "./notes",
  });

  assertThrows(
    () => parseDaemonCliArgs(["workspace", "init", "./notes", "./extra"]),
    CliUsageError,
  );
});

Deno.test("cli parser supports workspace register with optional alias", () => {
  assertHelpTopic(["workspace", "register", "--help"], "workspace-register");

  const withAlias = parseCommand([
    "workspace",
    "register",
    "--alias",
    "  docs  ",
    "./notes",
  ]);
  assertEquals(withAlias, {
    name: "workspace-register",
    alias: "docs",
    dirPath: "./notes",
  });

  const withoutAlias = parseCommand(["workspace", "register", "./notes"]);
  assertEquals(withoutAlias, {
    name: "workspace-register",
    dirPath: "./notes",
  });

  const aliasOnly = parseCommand([
    "workspace",
    "register",
    "--alias",
    "docs",
  ]);
  assertEquals(aliasOnly, {
    name: "workspace-register",
    alias: "docs",
  });
});

Deno.test("cli parser accepts workspace register alias=value compatibility syntax", () => {
  assertEquals(
    parseCommand(["workspace", "register", "alias=docs"]),
    {
      name: "workspace-register",
      alias: "docs",
    },
  );

  assertEquals(
    parseCommand(["workspace", "register", "./notes", "alias=docs"]),
    {
      name: "workspace-register",
      alias: "docs",
      dirPath: "./notes",
    },
  );

  assertThrows(
    () =>
      parseDaemonCliArgs([
        "workspace",
        "register",
        "--alias",
        "docs",
        "alias=other",
      ]),
    CliUsageError,
  );
});

Deno.test("cli parser validates workspace list and unregister usage", () => {
  assertHelpTopic(["workspace", "list", "-h"], "workspace-list");
  assertThrows(
    () => parseDaemonCliArgs(["workspace", "list", "extra"]),
    CliUsageError,
  );

  assertHelpTopic(
    ["workspace", "unregister", "--help"],
    "workspace-unregister",
  );

  const command = parseCommand(["workspace", "unregister", "docs"]);
  assertEquals(command, {
    name: "workspace-unregister",
    selector: "docs",
  });

  assertThrows(
    () => parseDaemonCliArgs(["workspace", "unregister"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["workspace", "unregister", "a", "b"]),
    CliUsageError,
  );
});

Deno.test("cli parser rejects unknown workspace subcommands", () => {
  assertThrows(
    () => parseDaemonCliArgs(["workspace", "bogus"]),
    CliUsageError,
  );
});

Deno.test("cli parser parses export output and format", () => {
  assertHelpTopic(["export", "--help"], "export");

  const command = parseCommand([
    "export",
    "sess-123",
    "--output",
    "./out.jsonl",
    "--format",
    "jsonl",
  ]);
  assertEquals(command, {
    name: "export",
    sessionId: "sess-123",
    outputPath: "./out.jsonl",
    format: "jsonl",
  });
});

Deno.test("cli parser validates export arity and format", () => {
  assertThrows(
    () => parseDaemonCliArgs(["export"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["export", "one", "two"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["export", "sess-123", "--format", "pdf"]),
    CliUsageError,
  );
});

Deno.test("cli parser parses clean day ranges and flags", () => {
  assertHelpTopic(["clean", "--help"], "clean");

  const command = parseCommand([
    "clean",
    "--recordings",
    "7",
    "--twins",
    "30",
    "--delete-metadata",
    "--dry-run",
  ]);
  assertEquals(command, {
    name: "clean",
    all: false,
    dryRun: true,
    recordingsDays: 7,
    twinsDays: 30,
    deleteTwinMetadata: true,
  });
});

Deno.test("cli parser validates clean argument values", () => {
  assertThrows(
    () => parseDaemonCliArgs(["clean", "--recordings", "0"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["clean", "--twins", "abc"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["clean", "--delete-metadata"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["clean"]),
    CliUsageError,
  );
});

Deno.test("cli parser handles top-level user help and usage errors", () => {
  assertHelpTopic(["user", "--help"], "user");
  assertThrows(
    () => parseDaemonCliArgs(["user"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "--help", "extra"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "bogus"]),
    CliUsageError,
  );
});

Deno.test("cli parser parses user init and user map commands", () => {
  assertHelpTopic(["user", "init", "-h"], "user");
  assertEquals(parseCommand(["user", "init"]), {
    name: "user-init",
  });

  assertEquals(parseCommand(["user", "map", "set", "docs", "dj"]), {
    name: "user-map-set",
    selector: "docs",
    username: "dj",
  });
  assertEquals(parseCommand(["user", "map", "list", "--json"]), {
    name: "user-map-list",
    asJson: true,
  });
  assertEquals(parseCommand(["user", "map", "delete", "docs"]), {
    name: "user-map-delete",
    selector: "docs",
  });
});

Deno.test("cli parser validates user map usage", () => {
  assertThrows(
    () => parseDaemonCliArgs(["user", "map"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "map", "set", "docs"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "map", "list", "extra"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "map", "delete"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "map", "bogus"]),
    CliUsageError,
  );
});

Deno.test("cli parser parses user default and exclude-me commands", () => {
  assertEquals(parseCommand(["user", "default", "set", "dj"]), {
    name: "user-default-set",
    username: "dj",
  });
  assertEquals(parseCommand(["user", "default", "clear"]), {
    name: "user-default-clear",
  });
  assertEquals(parseCommand(["user", "exclude-me", "true"]), {
    name: "user-exclude-me",
    value: true,
  });
  assertEquals(parseCommand(["user", "exclude-me", "false"]), {
    name: "user-exclude-me",
    value: false,
  });
});

Deno.test("cli parser validates user default and exclude-me usage", () => {
  assertThrows(
    () => parseDaemonCliArgs(["user", "default"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "default", "set"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "default", "clear", "extra"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "default", "bogus"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "exclude-me"]),
    CliUsageError,
  );
  assertThrows(
    () => parseDaemonCliArgs(["user", "exclude-me", "maybe"]),
    CliUsageError,
  );
});
