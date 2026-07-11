import { assertEquals } from "@std/assert";
import type { SessionActivityRow } from "../apps/web/src/loaders/sessions.ts";
import {
  applySessionTreeExpansion,
  buildSessionTree,
  resolveSessionAncestorIds,
  resolveSessionIdFromHash,
  resolveSessionTreeExpansion,
} from "../apps/web/src/session_tree.ts";

function makeRow(options: {
  id: string;
  state?: SessionActivityRow["state"];
  parentSessionId?: string;
  recognizedChild?: boolean;
  twinSizeBytes?: number;
  activeRecordingCount?: number;
  structuralContext?: boolean;
}): SessionActivityRow {
  return {
    sessionKey: `codex:provider-${options.id}`,
    provider: "codex",
    providerSessionId: `provider-${options.id}`,
    sessionId: options.id,
    sessionShortId: options.id,
    snippet: options.id,
    updatedAt: "2026-07-10T12:00:00.000Z",
    ...(options.twinSizeBytes === undefined
      ? {}
      : { twinSizeBytes: options.twinSizeBytes }),
    stale: options.state !== "active",
    state: options.state ?? "stale",
    activeRecordingCount: options.activeRecordingCount ?? 0,
    staleRecordingCount: 0,
    stoppedRecordingCount: 0,
    ...(options.parentSessionId || options.recognizedChild
      ? {
        relationship: {
          kind: "subconversation" as const,
          ...(options.parentSessionId
            ? { parentSessionId: options.parentSessionId }
            : {}),
        },
      }
      : {}),
    ...(options.structuralContext ? { structuralContext: true } : {}),
    recordings: [],
  };
}

Deno.test("buildSessionTree builds recursive trees and promotes roots by their best descendant", () => {
  const rows = [
    makeRow({
      id: "grandchild",
      state: "active",
      parentSessionId: "child",
      twinSizeBytes: 300,
      activeRecordingCount: 1,
    }),
    makeRow({ id: "unrelated", state: "active" }),
    makeRow({ id: "parent", twinSizeBytes: 100 }),
    makeRow({ id: "child", parentSessionId: "parent", twinSizeBytes: 200 }),
    makeRow({ id: "orphan", parentSessionId: "missing" }),
  ];

  const tree = buildSessionTree(rows);
  assertEquals(tree.roots.map((node) => node.row.sessionId), [
    "parent",
    "unrelated",
  ]);
  const parent = tree.roots[0];
  assertEquals(parent?.children.map((node) => node.row.sessionId), ["child"]);
  assertEquals(
    parent?.children[0]?.children.map((node) => node.row.sessionId),
    [
      "grandchild",
    ],
  );
  assertEquals(parent?.descendantCount, 2);
  assertEquals(parent?.activeDescendantCount, 1);
  assertEquals(parent?.descendantActiveRecordingCount, 1);
  assertEquals(parent?.descendantTwinSizeBytes, 500);
  assertEquals(tree.unlinked.map((node) => node.row.sessionId), ["orphan"]);
});

Deno.test("buildSessionTree fails open for cycles and ancestor lookup terminates", () => {
  const rows = [
    makeRow({ id: "cycle-a", parentSessionId: "cycle-b" }),
    makeRow({ id: "cycle-b", parentSessionId: "cycle-a" }),
    makeRow({ id: "known-orphan", recognizedChild: true }),
  ];

  const tree = buildSessionTree(rows);
  assertEquals(tree.roots, []);
  assertEquals(tree.unlinked.map((node) => node.row.sessionId), [
    "cycle-a",
    "cycle-b",
    "known-orphan",
  ]);
  assertEquals(resolveSessionAncestorIds(rows, "cycle-a"), ["cycle-b"]);
});

Deno.test("resolveSessionAncestorIds returns the complete outer-to-inner chain", () => {
  const rows = [
    makeRow({ id: "parent" }),
    makeRow({ id: "child", parentSessionId: "parent" }),
    makeRow({ id: "grandchild", parentSessionId: "child" }),
  ];

  assertEquals(resolveSessionAncestorIds(rows, "grandchild"), [
    "parent",
    "child",
  ]);
});

Deno.test("buildSessionTree ranks filtered groups by matching descendants, not context parents", () => {
  const rows = [
    makeRow({ id: "context-parent", structuralContext: true }),
    makeRow({ id: "newer-match", state: "active" }),
    makeRow({
      id: "older-child-match",
      state: "active",
      parentSessionId: "context-parent",
    }),
  ];

  assertEquals(
    buildSessionTree(rows).roots.map((node) => node.row.sessionId),
    ["newer-match", "context-parent"],
  );
});

Deno.test("resolveSessionTreeExpansion changes signature when a polled child gains a parent", () => {
  const orphanRows = [
    makeRow({ id: "child", recognizedChild: true }),
  ];
  const linkedRows = [
    makeRow({ id: "parent" }),
    makeRow({ id: "child", parentSessionId: "parent" }),
  ];

  const orphan = resolveSessionTreeExpansion(orphanRows, "child");
  const linked = resolveSessionTreeExpansion(linkedRows, "child");
  assertEquals(orphan?.ancestorSessionIds, []);
  assertEquals(orphan?.targetIsUnlinked, true);
  assertEquals(linked?.ancestorSessionIds, ["parent"]);
  assertEquals(linked?.targetIsUnlinked, false);
  assertEquals(orphan?.signature === linked?.signature, false);

  const initiallyOpen = new Set(["manually-open"]);
  const afterOrphan = applySessionTreeExpansion(
    initiallyOpen,
    orphan!,
    "unlinked",
  );
  const afterBackfill = applySessionTreeExpansion(
    afterOrphan,
    linked!,
    "unlinked",
  );
  assertEquals([...afterBackfill].sort(), [
    "manually-open",
    "parent",
    "unlinked",
  ]);
});

Deno.test("resolveSessionIdFromHash accepts session fragments and fails open on malformed input", () => {
  assertEquals(resolveSessionIdFromHash("#session-child%20id"), "child id");
  assertEquals(resolveSessionIdFromHash("#recording-child"), undefined);
  assertEquals(resolveSessionIdFromHash("#session-%E0%A4%A"), undefined);
});
