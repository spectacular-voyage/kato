import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  promptForWebPassword,
  type WebPasswordPromptIO,
} from "../apps/cli/src/commands/web_password_prompt.ts";

function encodeBytes(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

class FakeWebPasswordPromptIO implements WebPasswordPromptIO {
  readonly writes: string[] = [];
  readonly rawModes: boolean[] = [];

  constructor(private readonly input: number[]) {}

  read(buffer: Uint8Array): Promise<number | null> {
    const next = this.input.shift();
    if (next === undefined) {
      return Promise.resolve(null);
    }
    buffer[0] = next;
    return Promise.resolve(1);
  }

  setRaw(mode: boolean): void {
    this.rawModes.push(mode);
  }

  write(text: string): void {
    this.writes.push(text);
  }
}

Deno.test("promptForWebPassword accepts matching input and ignores a trailing CRLF", async () => {
  const io = new FakeWebPasswordPromptIO(encodeBytes("secret\r\nsecret\r\n"));

  const password = await promptForWebPassword(io);

  assertEquals(password, "secret");
  assertEquals(io.rawModes, [true, false, true, false]);
  assertEquals(
    io.writes,
    ["Web password: ", "\n", "Confirm web password: ", "\n"],
  );
});

Deno.test("promptForWebPassword retries on mismatch and empty input", async () => {
  const io = new FakeWebPasswordPromptIO(
    encodeBytes("\nfirst\nwrong\nsecond\nsecond\n"),
  );

  const password = await promptForWebPassword(io);

  assertEquals(password, "second");
  assertStringIncludes(io.writes.join(""), "Password must not be empty.");
  assertStringIncludes(
    io.writes.join(""),
    "Passwords did not match. Try again.",
  );
  assertEquals(io.rawModes, [
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
  ]);
});

Deno.test("promptForWebPassword restores raw mode when input aborts", async () => {
  const io = new FakeWebPasswordPromptIO(encodeBytes("sec"));

  await assertRejects(
    () => promptForWebPassword(io),
    Error,
    "Password prompt aborted before input was completed.",
  );

  assertEquals(io.rawModes, [true, false]);
});
