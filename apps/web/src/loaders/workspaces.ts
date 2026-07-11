import { join } from "@std/path";
import {
  DEFAULT_WORKSPACE_OUTPUT_DIR_RELATIVE,
  DEFAULT_WORKSPACE_TIMEZONE,
  type DendronWikilinkContextMode,
  isPathWithinRoots,
  loadUserSettings,
  loadWorkspaceConfigOverrides,
  resolveDefaultKatoDir,
  resolveDefaultSharedConfigPath,
  resolveDendronWikilinkContext,
  resolveWorkspaceDefaultOutputDir,
  SharedBehaviorConfigFileStore,
} from "@kato/runtime";
import {
  formatWorkspaceRegistryError,
  loadWorkspaceSummary,
  type WorkspaceSummary,
  type WorkspaceSummaryRow,
} from "./status.ts";
import { loadSessionActivityRows } from "./sessions.ts";
import { buildSessionInventorySessionHref } from "../session_routes.ts";

export interface WorkspaceRecordingEntry {
  key: string;
  state: "engaged-active" | "engaged-stale" | "stopped";
  provider: string;
  sessionId: string;
  sessionShortId: string;
  snippet?: string;
  outputPath: string;
  displayOutputPath: string;
  startedAt?: string;
  stoppedAt?: string;
  lastWriteAt?: string;
  sessionLink: string;
}

export interface WorkspaceManagementRow extends WorkspaceSummaryRow {
  workspaceUsername?: string;
  writePathCovered?: boolean;
  wikilinkContextMode?: DendronWikilinkContextMode;
  dendronConfigPath?: string;
  wikilinkifiableRoots?: string[];
  activeRecordingCount: number;
  staleRecordingCount: number;
  stoppedRecordingCount: number;
  latestRecordingAt?: string;
  recordings: WorkspaceRecordingEntry[];
}

export interface WorkspacesPageData {
  workspaceSummary: WorkspaceSummary;
  rows: WorkspaceManagementRow[];
  allowedWriteRoots: string[];
  sharedConfigError?: string;
}

export interface LoadWorkspacesPageDataOptions {
  katoDir?: string;
}

const WORKSPACE_DIAGNOSTIC_PROVIDER = "workspace";
const WORKSPACE_DIAGNOSTIC_SESSION_ID = "workspace-diagnostic";
const WORKSPACE_DIAGNOSTIC_OUTPUT_USERNAME = "workspace";
const WORKSPACE_DIAGNOSTIC_SNIPPET = "workspace";
const WORKSPACE_DIAGNOSTIC_NOW = new Date("2000-01-01T00:00:00.000Z");

function resolveRecordingActivityTimestamp(
  row: Pick<WorkspaceRecordingEntry, "lastWriteAt" | "stoppedAt" | "startedAt">,
): number {
  for (const value of [row.lastWriteAt, row.stoppedAt, row.startedAt]) {
    if (!value) {
      continue;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function resolveDiagnosticDefaultOutputDir(options: {
  workspaceRoot: string;
  defaultOutputDirTemplate: string;
  workspaceTimezone: string;
}): string | undefined {
  try {
    return resolveWorkspaceDefaultOutputDir({
      profile: {
        workspaceRoot: options.workspaceRoot,
        defaultOutputDirTemplate: options.defaultOutputDirTemplate,
        filenameTemplate: "{timestampHumane}-{provider}.md",
        workspaceTimezone: options.workspaceTimezone,
      },
      provider: WORKSPACE_DIAGNOSTIC_PROVIDER,
      sessionId: WORKSPACE_DIAGNOSTIC_SESSION_ID,
      now: WORKSPACE_DIAGNOSTIC_NOW,
      outputUsername: WORKSPACE_DIAGNOSTIC_OUTPUT_USERNAME,
      snapshotSnippet: WORKSPACE_DIAGNOSTIC_SNIPPET,
    });
  } catch {
    return undefined;
  }
}

export async function loadWorkspacesPageData(
  options: LoadWorkspacesPageDataOptions = {},
): Promise<WorkspacesPageData> {
  const katoDir = options.katoDir ?? resolveDefaultKatoDir();
  const sharedConfigStore = new SharedBehaviorConfigFileStore(
    resolveDefaultSharedConfigPath(katoDir),
  );
  const [workspaceSummary, sessionRows, userSettings] = await Promise.all([
    loadWorkspaceSummary({ katoDir }),
    loadSessionActivityRows({ katoDir, includeStale: true }),
    loadUserSettings({ katoDir }),
  ]);
  const workspaceUsernames = new Map(
    Object.entries(userSettings.config.participants.workspaceUsernames),
  );
  const recordingsByWorkspace = new Map<string, WorkspaceRecordingEntry[]>();

  for (const session of sessionRows) {
    for (const recording of session.recordings) {
      if (!recording.workspaceId) {
        continue;
      }
      const row: WorkspaceRecordingEntry = {
        key: `${recording.key}:${session.sessionId}`,
        state: recording.state,
        provider: session.provider,
        sessionId: session.sessionId,
        sessionShortId: session.sessionShortId,
        snippet: session.snippet,
        outputPath: recording.outputPath,
        displayOutputPath: recording.displayOutputPath,
        startedAt: recording.startedAt,
        stoppedAt: recording.stoppedAt,
        lastWriteAt: recording.lastWriteAt,
        sessionLink: buildSessionInventorySessionHref(session.sessionId, {
          workspaceFilter: recording.workspaceId,
        }),
      };
      const existing = recordingsByWorkspace.get(recording.workspaceId) ?? [];
      existing.push(row);
      recordingsByWorkspace.set(recording.workspaceId, existing);
    }
  }

  async function loadWikilinkDiagnostics(
    row: WorkspaceSummaryRow,
  ): Promise<
    Pick<
      WorkspaceManagementRow,
      "wikilinkContextMode" | "dendronConfigPath" | "wikilinkifiableRoots"
    >
  > {
    if (!row.valid) {
      return {};
    }

    try {
      const overrides = await loadWorkspaceConfigOverrides(row.configPath);
      const workspaceTimezone = overrides.workspaceTimezone ??
        DEFAULT_WORKSPACE_TIMEZONE;
      const resolvedDefaultOutputDir = resolveDiagnosticDefaultOutputDir({
        workspaceRoot: row.workspaceRoot,
        defaultOutputDirTemplate: overrides.defaultOutputDir ??
          DEFAULT_WORKSPACE_OUTPUT_DIR_RELATIVE,
        workspaceTimezone,
      }) ??
        resolveDiagnosticDefaultOutputDir({
          workspaceRoot: row.workspaceRoot,
          defaultOutputDirTemplate: DEFAULT_WORKSPACE_OUTPUT_DIR_RELATIVE,
          workspaceTimezone,
        });
      if (!resolvedDefaultOutputDir) {
        return {};
      }
      const context = await resolveDendronWikilinkContext(
        join(resolvedDefaultOutputDir, "__kato-wikilink-probe__.md"),
      );
      return {
        wikilinkContextMode: context.mode,
        dendronConfigPath: context.dendronConfigPath,
        wikilinkifiableRoots: [...context.wikilinkifiableRoots],
      };
    } catch {
      return {};
    }
  }

  async function augmentRows(
    rows: WorkspaceSummaryRow[],
    allowedWriteRoots: string[] | undefined,
  ): Promise<WorkspaceManagementRow[]> {
    return await Promise.all(rows.map(async (row) => {
      const recordings = [...(recordingsByWorkspace.get(row.workspaceId) ?? [])]
        .sort((a, b) => {
          const order = {
            "engaged-active": 0,
            "engaged-stale": 1,
            "stopped": 2,
          } as const;
          const statusDiff = order[a.state] - order[b.state];
          if (statusDiff !== 0) {
            return statusDiff;
          }
          return resolveRecordingActivityTimestamp(b) -
            resolveRecordingActivityTimestamp(a);
        });
      const latestRecordingAt = recordings[0]?.lastWriteAt ??
        recordings[0]?.stoppedAt ??
        recordings[0]?.startedAt;
      const wikilinkDiagnostics = await loadWikilinkDiagnostics(row);
      return {
        ...row,
        workspaceUsername: workspaceUsernames.get(row.workspaceId),
        writePathCovered: allowedWriteRoots
          ? isPathWithinRoots(row.workspaceRoot, allowedWriteRoots)
          : undefined,
        ...wikilinkDiagnostics,
        activeRecordingCount: recordings.filter((recording) =>
          recording.state === "engaged-active"
        ).length,
        staleRecordingCount: recordings.filter((recording) =>
          recording.state === "engaged-stale"
        ).length,
        stoppedRecordingCount: recordings.filter((recording) =>
          recording.state === "stopped"
        ).length,
        latestRecordingAt,
        recordings,
      };
    }));
  }

  try {
    const sharedConfig = await sharedConfigStore.load();
    return {
      workspaceSummary,
      rows: await augmentRows(
        workspaceSummary.rows,
        sharedConfig.allowedWriteRoots,
      ),
      allowedWriteRoots: [...sharedConfig.allowedWriteRoots],
    };
  } catch (error) {
    return {
      workspaceSummary,
      rows: await augmentRows(workspaceSummary.rows, undefined),
      allowedWriteRoots: [],
      sharedConfigError: formatWorkspaceRegistryError(error),
    };
  }
}
