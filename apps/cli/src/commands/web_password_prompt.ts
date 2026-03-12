export interface WebPasswordPromptIO {
  read(buffer: Uint8Array): Promise<number | null>;
  setRaw(mode: boolean): void;
  write(text: string): void;
}

export function createDefaultWebPasswordPromptIO(
  write: (text: string) => void,
): WebPasswordPromptIO {
  return {
    read: (buffer) => Deno.stdin.read(buffer),
    setRaw: (mode) => Deno.stdin.setRaw(mode),
    write,
  };
}

interface PromptReadState {
  skipLeadingLineFeed: boolean;
}

const decoder = new TextDecoder();

async function readHiddenInputLine(
  io: WebPasswordPromptIO,
  prompt: string,
  state: PromptReadState,
): Promise<string> {
  const bytes: number[] = [];
  const buffer = new Uint8Array(1);

  io.write(prompt);
  io.setRaw(true);

  try {
    while (true) {
      const read = await io.read(buffer);
      if (read === null) {
        io.write("\n");
        throw new Error("Password prompt aborted before input was completed.");
      }
      if (read === 0) {
        continue;
      }

      const byte = buffer[0];
      if (state.skipLeadingLineFeed) {
        state.skipLeadingLineFeed = false;
        if (byte === 0x0a) {
          continue;
        }
      }

      if (byte === 0x03) {
        io.write("\n");
        throw new Error("Password prompt cancelled.");
      }
      if (byte === 0x04) {
        io.write("\n");
        throw new Error("Password prompt aborted before input was completed.");
      }
      if (byte === 0x0d) {
        state.skipLeadingLineFeed = true;
        io.write("\n");
        break;
      }
      if (byte === 0x0a) {
        io.write("\n");
        break;
      }
      if (byte === 0x08 || byte === 0x7f) {
        if (bytes.length > 0) {
          bytes.pop();
        }
        continue;
      }

      bytes.push(byte);
    }
  } finally {
    io.setRaw(false);
  }

  return decoder.decode(new Uint8Array(bytes));
}

export async function promptForWebPassword(
  io: WebPasswordPromptIO,
): Promise<string> {
  const state: PromptReadState = { skipLeadingLineFeed: false };

  while (true) {
    const password = await readHiddenInputLine(io, "Web password: ", state);
    if (password.length === 0) {
      io.write("Password must not be empty.\n");
      continue;
    }

    const confirm = await readHiddenInputLine(
      io,
      "Confirm web password: ",
      state,
    );
    if (confirm.length === 0) {
      io.write("Password confirmation must not be empty.\n");
      continue;
    }
    if (confirm !== password) {
      io.write("Passwords did not match. Try again.\n");
      continue;
    }

    return password;
  }
}
