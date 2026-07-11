import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { readCodexSessionMeta } from "../apps/daemon/src/providers/codex/mod.ts";
import { withTestTempDir } from "./test_temp.ts";

async function writeSessionMeta(
  dir: string,
  name: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const path = join(dir, `${name}.jsonl`);
  await Deno.writeTextFile(
    path,
    `${JSON.stringify({ type: "session_meta", payload })}\nignored\n`,
  );
  return path;
}

Deno.test("readCodexSessionMeta distinguishes top-level and nested sub-conversations", async () => {
  await withTestTempDir("codex-session-meta-", async (dir) => {
    const topLevelPath = await writeSessionMeta(dir, "top-level", {
      id: "thread-root",
      source: "vscode",
      thread_source: "user",
    });
    assertEquals(await readCodexSessionMeta(topLevelPath), {
      id: "thread-root",
      source: "vscode",
    });

    const childPath = await writeSessionMeta(dir, "child", {
      id: "thread-child",
      session_id: "thread-root",
      parent_thread_id: "misleading-top-level-field",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "thread-root",
            depth: 1,
            agent_path: "/root/relation_audit",
          },
        },
      },
      thread_source: "subagent",
    });
    assertEquals(await readCodexSessionMeta(childPath), {
      id: "thread-child",
      source: "",
      parentProviderSessionId: "thread-root",
    });

    const nestedPath = await writeSessionMeta(dir, "nested", {
      id: "thread-grandchild",
      session_id: "thread-root",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "thread-child",
            depth: 2,
            agent_path: "/root/relation_audit/nested_check",
          },
        },
      },
      thread_source: "subagent",
    });
    assertEquals(await readCodexSessionMeta(nestedPath), {
      id: "thread-grandchild",
      source: "",
      parentProviderSessionId: "thread-child",
    });
  });
});

Deno.test("readCodexSessionMeta ignores malformed or merely suggestive parent fields", async () => {
  await withTestTempDir("codex-session-meta-malformed-", async (dir) => {
    const malformedPath = await writeSessionMeta(dir, "malformed", {
      id: "thread-not-a-child",
      session_id: "thread-root",
      parent_thread_id: "thread-root",
      thread_source: "subagent",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "   ",
          },
        },
      },
    });

    assertEquals(await readCodexSessionMeta(malformedPath), {
      id: "thread-not-a-child",
      source: "",
    });
  });
});
