import { assertEquals, assertStringIncludes } from "@std/assert";
import { detectInChatControlCommands } from "../apps/daemon/src/mod.ts";

Deno.test("detectInChatControlCommands parses strict control commands", () => {
  const result = detectInChatControlCommands(`
Intro text
::record-My.Proj notes/session.md
::capture-My.Proj notes/capture.md
  ::export-My.Proj notes/export.md
::stop
`);

  assertEquals(result.errors.length, 0);
  assertEquals(result.commands.length, 4);

  assertEquals(result.commands[0]?.verb, "record");
  assertEquals(result.commands[0]?.name, "record");
  assertEquals(result.commands[0]?.alias, "My.Proj");
  assertEquals(result.commands[0]?.argument, "notes/session.md");
  assertEquals(result.commands[1]?.verb, "capture");
  assertEquals(result.commands[1]?.name, "capture");
  assertEquals(result.commands[1]?.alias, "My.Proj");
  assertEquals(result.commands[2]?.verb, "export");
  assertEquals(result.commands[2]?.name, "export");
  assertEquals(result.commands[2]?.alias, "My.Proj");
  assertEquals(result.commands[2]?.argument, "notes/export.md");
  assertEquals(result.commands[3]?.verb, "stop");
  assertEquals(result.commands[3]?.name, "stop");
  assertEquals(result.commands[3]?.alias, undefined);
  assertEquals(result.commands[3]?.argument, undefined);
});

Deno.test("detectInChatControlCommands ignores inline and fenced code blocks", () => {
  const result = detectInChatControlCommands(`
Use \`::record notes/not-a-command.md\` in docs.
\`\`\`md
::record-myproj notes/in-fence.md
::stop
\`\`\`
::capture-myproj notes/real-command.md
`);

  assertEquals(result.errors.length, 0);
  assertEquals(result.commands.length, 1);
  assertEquals(result.commands[0]?.name, "capture");
  assertEquals(result.commands[0]?.alias, "myproj");
  assertEquals(result.commands[0]?.argument, "notes/real-command.md");
});

Deno.test("detectInChatControlCommands rejects ::init as unsupported", () => {
  const result = detectInChatControlCommands(`
::init
`);

  assertEquals(result.commands.length, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(
    result.errors[0]?.reason ?? "",
    "Unsupported control command",
  );
});

Deno.test("detectInChatControlCommands rejects ::init-<alias> as unsupported", () => {
  const result = detectInChatControlCommands(`
::init-myproj notes/session.md
`);

  assertEquals(result.commands.length, 0);
  assertEquals(result.errors.length, 1);
  assertStringIncludes(
    result.errors[0]?.reason ?? "",
    "Unsupported control command",
  );
});

Deno.test("detectInChatControlCommands fails closed on invalid command lines", () => {
  const result = detectInChatControlCommands(`
::start
::export
::record-myproj /tmp/should-fail.md
::stop id:abc12345
`);

  assertEquals(result.commands.length, 1);
  assertEquals(result.errors.length, 3);
  assertStringIncludes(
    result.errors[0]?.reason ?? "",
    "Unknown control command",
  );
  assertStringIncludes(
    result.errors[1]?.reason ?? "",
    "requires a workspace alias suffix",
  );
  assertStringIncludes(
    result.errors[2]?.reason ?? "",
    "does not accept arguments",
  );
});
