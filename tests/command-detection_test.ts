import { assertEquals, assertStringIncludes } from "@std/assert";
import { detectInChatControlCommands } from "../apps/daemon/src/mod.ts";

Deno.test("detectInChatControlCommands parses strict control commands", () => {
  const result = detectInChatControlCommands(`
Intro text
::record notes/session.md
::start
  ::capture notes/capture.md
::stop id:abc12345
`);

  assertEquals(result.errors.length, 0);
  assertEquals(result.commands.length, 4);

  assertEquals(result.commands[0]?.name, "record");
  assertEquals(result.commands[0]?.argument, "notes/session.md");
  assertEquals(result.commands[1]?.name, "start");
  assertEquals(result.commands[2]?.name, "capture");
  assertEquals(result.commands[3]?.name, "stop");
  assertEquals(result.commands[3]?.argument, "id:abc12345");
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
::wat nope
::export
`);

  assertEquals(result.commands.length, 0);
  assertEquals(result.errors.length, 2);
  assertStringIncludes(
    result.errors[0]?.reason ?? "",
    "Unknown control command",
  );
  assertStringIncludes(
    result.errors[1]?.reason ?? "",
    "requires a path argument",
  );
});
