import type { SessionActivityRow } from "./loaders/sessions.ts";

export interface SessionTreeNode {
  row: SessionActivityRow;
  children: SessionTreeNode[];
  descendantCount: number;
  activeDescendantCount: number;
  descendantActiveRecordingCount: number;
  descendantTwinSizeBytes?: number;
}

export interface SessionTreeModel {
  roots: SessionTreeNode[];
  unlinked: SessionTreeNode[];
}

export interface SessionTreeExpansion {
  ancestorSessionIds: string[];
  targetIsUnlinked: boolean;
  signature: string;
}

interface MutableSessionTreeNode extends SessionTreeNode {
  order: number;
  bestSubtreeOrder: number;
  children: MutableSessionTreeNode[];
}

function relationshipParentSessionId(
  row: SessionActivityRow | undefined,
): string | undefined {
  return row?.relationship?.parentSessionId;
}

function relationshipChainHasCycle(
  startSessionId: string,
  rowsBySessionId: ReadonlyMap<string, SessionActivityRow>,
): boolean {
  const visited = new Set<string>();
  let currentSessionId: string | undefined = startSessionId;
  while (currentSessionId) {
    if (visited.has(currentSessionId)) {
      return true;
    }
    visited.add(currentSessionId);
    const current = rowsBySessionId.get(currentSessionId);
    const parentSessionId = relationshipParentSessionId(current);
    if (!parentSessionId || !rowsBySessionId.has(parentSessionId)) {
      return false;
    }
    currentSessionId = parentSessionId;
  }
  return false;
}

function finalizeNode(node: MutableSessionTreeNode): void {
  for (const child of node.children) {
    finalizeNode(child);
  }
  node.children.sort((a, b) =>
    a.bestSubtreeOrder - b.bestSubtreeOrder || a.order - b.order
  );

  node.bestSubtreeOrder = node.children.reduce(
    (best, child) => Math.min(best, child.bestSubtreeOrder),
    node.row.structuralContext ? Number.POSITIVE_INFINITY : node.order,
  );
  node.descendantCount = node.children.reduce(
    (count, child) => count + 1 + child.descendantCount,
    0,
  );
  node.activeDescendantCount = node.children.reduce(
    (count, child) =>
      count + Number(child.row.state === "active") +
      child.activeDescendantCount,
    0,
  );
  node.descendantActiveRecordingCount = node.children.reduce(
    (count, child) =>
      count + child.row.activeRecordingCount +
      child.descendantActiveRecordingCount,
    0,
  );

  let descendantTwinSizeBytes = 0;
  let hasDescendantTwin = false;
  for (const child of node.children) {
    if (child.row.twinSizeBytes !== undefined) {
      descendantTwinSizeBytes += child.row.twinSizeBytes;
      hasDescendantTwin = true;
    }
    if (child.descendantTwinSizeBytes !== undefined) {
      descendantTwinSizeBytes += child.descendantTwinSizeBytes;
      hasDescendantTwin = true;
    }
  }
  if (hasDescendantTwin) {
    node.descendantTwinSizeBytes = descendantTwinSizeBytes;
  }
}

export function buildSessionTree(rows: SessionActivityRow[]): SessionTreeModel {
  const rowsBySessionId = new Map(
    rows.map((row) => [row.sessionId, row]),
  );
  const nodesBySessionId = new Map<string, MutableSessionTreeNode>();
  rows.forEach((row, order) => {
    nodesBySessionId.set(row.sessionId, {
      row,
      children: [],
      descendantCount: 0,
      activeDescendantCount: 0,
      descendantActiveRecordingCount: 0,
      order,
      bestSubtreeOrder: row.structuralContext
        ? Number.POSITIVE_INFINITY
        : order,
    });
  });

  const attached = new Set<string>();
  const unlinkedSessionIds = new Set<string>();
  for (const row of rows) {
    if (!row.relationship) {
      continue;
    }
    const parentSessionId = row.relationship.parentSessionId;
    const parent = parentSessionId
      ? nodesBySessionId.get(parentSessionId)
      : undefined;
    if (
      !parent || parentSessionId === row.sessionId ||
      relationshipChainHasCycle(row.sessionId, rowsBySessionId)
    ) {
      unlinkedSessionIds.add(row.sessionId);
      continue;
    }
    parent.children.push(nodesBySessionId.get(row.sessionId)!);
    attached.add(row.sessionId);
  }

  const roots = rows
    .filter((row) => !row.relationship && !attached.has(row.sessionId))
    .map((row) => nodesBySessionId.get(row.sessionId)!);
  const unlinked = rows
    .filter((row) =>
      unlinkedSessionIds.has(row.sessionId) && !attached.has(row.sessionId)
    )
    .map((row) => nodesBySessionId.get(row.sessionId)!);

  for (const node of [...roots, ...unlinked]) {
    finalizeNode(node);
  }
  roots.sort((a, b) =>
    a.bestSubtreeOrder - b.bestSubtreeOrder || a.order - b.order
  );
  unlinked.sort((a, b) =>
    a.bestSubtreeOrder - b.bestSubtreeOrder || a.order - b.order
  );

  return { roots, unlinked };
}

export function resolveSessionAncestorIds(
  rows: SessionActivityRow[],
  targetSessionId: string,
): string[] {
  const rowsBySessionId = new Map(
    rows.map((row) => [row.sessionId, row]),
  );
  const ancestors: string[] = [];
  const visited = new Set([targetSessionId]);
  let current = rowsBySessionId.get(targetSessionId);
  while (current?.relationship?.parentSessionId) {
    const parentSessionId = current.relationship.parentSessionId;
    if (visited.has(parentSessionId)) {
      break;
    }
    const parent = rowsBySessionId.get(parentSessionId);
    if (!parent) {
      break;
    }
    visited.add(parentSessionId);
    ancestors.push(parentSessionId);
    current = parent;
  }
  return ancestors.reverse();
}

function treeContainsSession(
  nodes: SessionTreeNode[],
  sessionId: string,
): boolean {
  return nodes.some((node) =>
    node.row.sessionId === sessionId ||
    treeContainsSession(node.children, sessionId)
  );
}

export function resolveSessionTreeExpansion(
  rows: SessionActivityRow[],
  targetSessionId: string,
  tree: SessionTreeModel = buildSessionTree(rows),
): SessionTreeExpansion | undefined {
  if (!rows.some((row) => row.sessionId === targetSessionId)) {
    return undefined;
  }
  const ancestorSessionIds = resolveSessionAncestorIds(rows, targetSessionId);
  const targetIsUnlinked = treeContainsSession(
    tree.unlinked,
    targetSessionId,
  );
  return {
    ancestorSessionIds,
    targetIsUnlinked,
    signature: JSON.stringify([
      targetSessionId,
      targetIsUnlinked,
      ancestorSessionIds,
    ]),
  };
}

export function applySessionTreeExpansion(
  current: ReadonlySet<string>,
  expansion: SessionTreeExpansion,
  unlinkedTreeKey: string,
): Set<string> {
  const next = new Set(current);
  for (const ancestorSessionId of expansion.ancestorSessionIds) {
    next.add(ancestorSessionId);
  }
  if (expansion.targetIsUnlinked) {
    next.add(unlinkedTreeKey);
  }
  return next;
}

export function resolveSessionIdFromHash(hash: string): string | undefined {
  if (!hash.startsWith("#session-")) {
    return undefined;
  }
  try {
    const sessionId = decodeURIComponent(hash.slice("#session-".length));
    return sessionId.length > 0 ? sessionId : undefined;
  } catch {
    return undefined;
  }
}
