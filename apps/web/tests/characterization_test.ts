// Records what the built Fresh server does today, so the server replacing it
// can be held to the same behaviour (task.2026.2026-11-10-leave-fresh).
// `deno task test:web` builds the app first; the harness isolates HOME.
import { FRESH_TARGET } from "./characterization/harness.ts";
import { runCharacterization } from "./characterization/run.ts";

Deno.test("Kato Web characterization: built Fresh server", async (t) => {
  await runCharacterization(t, FRESH_TARGET);
});
