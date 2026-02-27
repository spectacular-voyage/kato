import { assertEquals, assertStringIncludes } from "@std/assert";
import { detectInChatControlCommands } from "../apps/daemon/src/mod.ts";

Deno.test("detectInChatControlCommands parses strict control commands", () => {
  const result = detectInChatControlCommands(`
Intro text
::init /tmp/session.md
::record
  ::capture /tmp/capture.md
::stop
`);

  assertEquals(result.errors.length, 0);
  assertEquals(result.commands.length, 4);

  assertEquals(result.commands[0]?.name, "init");
  assertEquals(result.commands[0]?.argument, "/tmp/session.md");
  assertEquals(result.commands[1]?.name, "record");
  assertEquals(result.commands[2]?.name, "capture");
  assertEquals(result.commands[2]?.argument, "/tmp/capture.md");
  assertEquals(result.commands[3]?.name, "stop");
  assertEquals(result.commands[3]?.argument, undefined);
});

Deno.test("detectInChatControlCommands ignores inline and fenced code blocks", () => {
  const result = detectInChatControlCommands(`
Use \`::record notes/not-a-command.md\` in docs.
\`\`\`md
::record notes/in-fence.md
::stop
\`\`\`
::capture notes/real-command.md
`);

  assertEquals(result.errors.length, 0);
  assertEquals(result.commands.length, 1);
  assertEquals(result.commands[0]?.name, "capture");
  assertEquals(result.commands[0]?.argument, "notes/real-command.md");
});

Deno.test("detectInChatControlCommands fails closed on invalid command lines", () => {
  const result = detectInChatControlCommands(`
::start
::export
::record /tmp/should-fail.md
::stop id:abc12345
`);

  assertEquals(result.commands.length, 0);
  assertEquals(result.errors.length, 4);
  assertStringIncludes(
    result.errors[0]?.reason ?? "",
    "Unknown control command",
  );
  assertStringIncludes(
    result.errors[1]?.reason ?? "",
    "requires a path argument",
  );
  assertStringIncludes(
    result.errors[2]?.reason ?? "",
    "does not accept arguments",
  );
  assertStringIncludes(
    result.errors[3]?.reason ?? "",
    "does not accept arguments",
  );
});
