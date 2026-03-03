import { parse, stringify } from "@std/yaml";
import { join } from "@std/path";

function requireHomeDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home) {
    throw new Error("HOME/USERPROFILE not set");
  }
  return home;
}

function asConfigRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label} yaml config`);
  }
  return value as Record<string, unknown>;
}

async function updateYamlConfig(
  path: string,
  label: string,
  update: (config: Record<string, unknown>) => void,
): Promise<void> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Missing ${label} config at ${path}. Run \`kato init\` first.`,
      );
    }
    throw error;
  }
  const parsed = parse(raw);
  const config = asConfigRecord(parsed, label);
  update(config);
  await Deno.writeTextFile(path, `${stringify(config).trimEnd()}\n`);
}

const home = requireHomeDir();
const daemonPath = join(home, ".kato", "daemon", "kato-daemon-config.yaml");
const sharedPath = join(home, ".kato", "shared", "kato-shared-config.yaml");

await updateYamlConfig(daemonPath, "daemon", (config) => {
  config.providerSessionRoots = {
    claude: [join(home, ".kato", "test-provider", "claude")],
    codex: [join(home, ".kato", "test-provider", "codex")],
    gemini: [join(home, ".kato", "test-provider", "gemini")],
  };
});

await updateYamlConfig(sharedPath, "shared", (config) => {
  config.allowedWriteRoots = [join(home, ".kato", "test-output")];
});
