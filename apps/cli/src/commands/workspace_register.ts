import type { DaemonCliCommandContext } from "./context.ts";
import {
  ensureWorkspaceConfigWorkspaceId,
  readWorkspaceConfigWorkspaceId,
  type RegisteredWorkspace,
} from "@kato/runtime";
import {
  findWorkspaceByRoot,
  formatWorkspaceEntry,
  resolveRegisterTarget,
  resolveWorkspaceRegistryStore,
  shouldWarnWriteRootCoverage,
  validateWorkspaceAlias,
} from "./workspace_shared.ts";

function cloneEntry(entry: RegisteredWorkspace): RegisteredWorkspace {
  return {
    workspaceId: entry.workspaceId,
    alias: entry.alias,
    workspaceRoot: entry.workspaceRoot,
    configPath: entry.configPath,
    registeredAt: entry.registeredAt,
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}

export async function runWorkspaceRegisterCommand(
  ctx: DaemonCliCommandContext,
  alias: string,
  dirPath?: string,
): Promise<void> {
  const target = await resolveRegisterTarget(ctx, dirPath);
  const store = resolveWorkspaceRegistryStore(ctx);
  const entries = await store.load();
  const configuredWorkspaceId = await readWorkspaceConfigWorkspaceId(
    target.configPath,
    { allowMissing: true },
  );

  const requestedAlias = validateWorkspaceAlias(alias);

  const existingByAlias = entries.find((entry) =>
    entry.alias === requestedAlias
  );
  const existingByWorkspaceIdAlias = entries.find((entry) =>
    entry.workspaceId === requestedAlias
  );
  const existingByWorkspaceId = configuredWorkspaceId
    ? entries.find((entry) => entry.workspaceId === configuredWorkspaceId)
    : undefined;
  const existingByRoot = findWorkspaceByRoot(
    entries,
    target.workspaceRoot,
    target.configPath,
  );
  if (
    existingByWorkspaceId &&
    existingByRoot &&
    existingByWorkspaceId.workspaceId !== existingByRoot.workspaceId
  ) {
    throw new Error(
      "Workspace config conflicts with an existing registry entry at this path",
    );
  }
  const existingWorkspace = existingByWorkspaceId ?? existingByRoot;

  if (existingByWorkspaceIdAlias) {
    throw new Error(`Workspace alias already registered: ${requestedAlias}`);
  }

  if (
    existingByAlias &&
    (!existingWorkspace ||
      existingByAlias.workspaceId !== existingWorkspace.workspaceId)
  ) {
    throw new Error(`Workspace alias already registered: ${requestedAlias}`);
  }

  const nowIso = ctx.runtime.now().toISOString();
  let changed = false;
  let created = false;
  let restartRequired = false;
  let nextEntries: RegisteredWorkspace[];
  let finalEntry: RegisteredWorkspace;

  if (!existingWorkspace) {
    created = true;
    finalEntry = {
      workspaceId: configuredWorkspaceId ?? crypto.randomUUID(),
      alias: requestedAlias,
      workspaceRoot: target.workspaceRoot,
      configPath: target.configPath,
      registeredAt: nowIso,
    };
    nextEntries = [...entries, cloneEntry(finalEntry)];
    changed = true;
  } else {
    const updated: RegisteredWorkspace = {
      ...existingWorkspace,
      alias: requestedAlias,
      workspaceRoot: target.workspaceRoot,
      configPath: target.configPath,
      updatedAt: nowIso,
    };
    changed = updated.alias !== existingWorkspace.alias ||
      updated.workspaceRoot !== existingWorkspace.workspaceRoot ||
      updated.configPath !== existingWorkspace.configPath;
    restartRequired = changed;
    finalEntry = updated;
    nextEntries = entries.map((entry) =>
      entry.workspaceId === existingWorkspace.workspaceId
        ? cloneEntry(updated)
        : cloneEntry(entry)
    );
  }

  if (changed) {
    await store.save(nextEntries);
  }
  await ensureWorkspaceConfigWorkspaceId(
    target.configPath,
    finalEntry.workspaceId,
  );

  await ctx.operationalLogger.info(
    created
      ? "workspace.register.created"
      : changed
      ? "workspace.register.updated"
      : "workspace.register.unchanged",
    created
      ? "Registered workspace alias"
      : changed
      ? "Updated registered workspace alias"
      : "Workspace alias already registered",
    {
      workspaceId: finalEntry.workspaceId,
      alias: finalEntry.alias,
      workspaceRoot: finalEntry.workspaceRoot,
      configPath: finalEntry.configPath,
      created,
      changed,
      restartRequired,
    },
  );
  await ctx.auditLogger.command("workspace-register", {
    workspaceId: finalEntry.workspaceId,
    alias: finalEntry.alias,
    workspaceRoot: finalEntry.workspaceRoot,
    configPath: finalEntry.configPath,
    created,
    changed,
    restartRequired,
  });

  const lines = [
    `${
      created
        ? "workspace registered"
        : changed
        ? "workspace registration updated"
        : "workspace already registered"
    }: ${formatWorkspaceEntry(finalEntry)}`,
  ];
  if (restartRequired) {
    lines.push(
      "restart required before alias/root/config-path changes are used by the running daemon",
    );
  } else if (
    created && shouldWarnWriteRootCoverage(ctx, finalEntry.workspaceRoot)
  ) {
    lines.push(
      "warning: the running daemon may still deny writes for this workspace until `kato restart` expands allowedWriteRoots",
    );
  }
  ctx.runtime.writeStdout(`${lines.join("\n")}\n`);
}
