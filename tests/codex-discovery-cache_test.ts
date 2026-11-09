import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type CodexSessionMetaCache,
  discoverCodexSessions,
} from "../apps/daemon/src/orchestrator/provider_ingestion.ts";
import { withTestTempDir } from "./test_temp.ts";

function metaLine(id: string, source = "cli"): string {
  return `${
    JSON.stringify({ type: "session_meta", payload: { id, source } })
  }\n`;
}

function eventLine(text: string): string {
  return `${
    JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: text },
    })
  }\n`;
}

async function discoveredIds(
  root: string,
  cache: CodexSessionMetaCache,
): Promise<string[]> {
  return (await discoverCodexSessions([root], cache))
    .map((session) => session.sessionId)
    .sort();
}

Deno.test("discoverCodexSessions reuses cached session_meta for appended rollouts", async () => {
  await withTestTempDir("codex-discovery-cache-", async (root) => {
    const a = join(root, "rollout-a.jsonl");
    const execRollout = join(root, "rollout-exec.jsonl");
    await Deno.writeTextFile(a, metaLine("sess-a") + eventLine("hi"));
    await Deno.writeTextFile(execRollout, metaLine("sess-exec", "exec"));
    const cache: CodexSessionMetaCache = new Map();

    assertEquals(await discoveredIds(root, cache), ["sess-a"]);
    assertEquals(cache.size, 2);

    // An in-place rewrite that keeps the inode and does not shrink is
    // indistinguishable from an append, so the cached first line is reused
    // (rollouts are append-only; this proves the file was not re-read).
    await Deno.writeTextFile(
      a,
      metaLine("sess-rewritten") + eventLine("hi") + eventLine("more"),
    );
    assertEquals(await discoveredIds(root, cache), ["sess-a"]);

    // A shrunken file is re-read.
    await Deno.writeTextFile(a, metaLine("sess-b"));
    assertEquals(await discoveredIds(root, cache), ["sess-b"]);

    // A replaced file (new inode) is re-read even when it is larger.
    const staged = join(root, "staged.tmp");
    await Deno.writeTextFile(
      staged,
      metaLine("sess-c") + eventLine("replacement ".repeat(20)),
    );
    await Deno.rename(staged, a);
    assertEquals(await discoveredIds(root, cache), ["sess-c"]);

    // Deleted files are pruned from the cache.
    await Deno.remove(execRollout);
    await discoveredIds(root, cache);
    assertEquals([...cache.keys()], [a]);
  });
});

Deno.test("discoverCodexSessions retries rollouts whose first line is not written yet", async () => {
  await withTestTempDir("codex-discovery-pending-", async (root) => {
    const pending = join(root, "rollout-pending.jsonl");
    await Deno.writeTextFile(pending, "");
    const cache: CodexSessionMetaCache = new Map();

    assertEquals(await discoveredIds(root, cache), []);
    assertEquals(cache.size, 0);

    await Deno.writeTextFile(pending, metaLine("sess-late"));
    assertEquals(await discoveredIds(root, cache), ["sess-late"]);
  });
});

Deno.test("discoverCodexSessions without a cache reads every rollout", async () => {
  await withTestTempDir("codex-discovery-nocache-", async (root) => {
    const a = join(root, "rollout-a.jsonl");
    await Deno.writeTextFile(a, metaLine("sess-a") + eventLine("hi"));
    assertEquals(
      (await discoverCodexSessions([root])).map((s) => s.sessionId),
      ["sess-a"],
    );
    await Deno.writeTextFile(a, metaLine("sess-b") + eventLine("hi there"));
    assertEquals(
      (await discoverCodexSessions([root])).map((s) => s.sessionId),
      ["sess-b"],
    );
  });
});
