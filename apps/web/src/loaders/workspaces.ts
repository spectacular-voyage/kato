import {
  isPathWithinRoots,
  resolveDefaultKatoDir,
  resolveDefaultSharedConfigPath,
  SharedBehaviorConfigFileStore,
} from "@kato/runtime";
import {
  formatWorkspaceRegistryError,
  loadWorkspaceSummary,
  type WorkspaceSummary,
  type WorkspaceSummaryRow,
} from "./status.ts";

export interface WorkspaceManagementRow extends WorkspaceSummaryRow {
  writePathCovered?: boolean;
}

export interface WorkspacesPageData {
  workspaceSummary: WorkspaceSummary;
  rows: WorkspaceManagementRow[];
  allowedWriteRoots: string[];
  sharedConfigError?: string;
}

export async function loadWorkspacesPageData(): Promise<WorkspacesPageData> {
  const katoDir = resolveDefaultKatoDir();
  const sharedConfigStore = new SharedBehaviorConfigFileStore(
    resolveDefaultSharedConfigPath(katoDir),
  );
  const workspaceSummary = await loadWorkspaceSummary();

  try {
    const sharedConfig = await sharedConfigStore.load();
    return {
      workspaceSummary,
      rows: workspaceSummary.rows.map((row) => ({
        ...row,
        writePathCovered: isPathWithinRoots(
          row.workspaceRoot,
          sharedConfig.allowedWriteRoots,
        ),
      })),
      allowedWriteRoots: [...sharedConfig.allowedWriteRoots],
    };
  } catch (error) {
    return {
      workspaceSummary,
      rows: workspaceSummary.rows.map((row) => ({
        ...row,
        writePathCovered: undefined,
      })),
      allowedWriteRoots: [],
      sharedConfigError: formatWorkspaceRegistryError(error),
    };
  }
}
