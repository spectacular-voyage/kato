import { PersistentSessionStateStore } from "../../orchestrator/mod.ts";
import type { DaemonCliCommandContext } from "./context.ts";
import { defaultWorkspaceRoot } from "./attachments_shared.ts";

function describeSession(
  ctx: DaemonCliCommandContext,
  all: boolean,
  metadata: Awaited<
    ReturnType<PersistentSessionStateStore["listSessionMetadata"]>
  >[number],
): string | undefined {
  const attachment = metadata.workspaceAttachment;
  if (!attachment && !all) {
    return undefined;
  }

  const mode = attachment ? "attached" : "default";
  const workspaceRoot = attachment?.workspaceRoot ??
    defaultWorkspaceRoot(ctx.runtimeConfig);
  const sourceConfigPath = attachment?.sourceConfigPath;
  return `${metadata.provider}/${
    metadata.sessionId.slice(0, 8)
  } (${metadata.providerSessionId}) [${mode}] workspace=${workspaceRoot}${
    sourceConfigPath ? ` config=${sourceConfigPath}` : ""
  }${
    metadata.primaryRecordingDestination
      ? ` output=${metadata.primaryRecordingDestination}`
      : ""
  }`;
}

export async function runAttachmentsCommand(
  ctx: DaemonCliCommandContext,
  all: boolean,
): Promise<void> {
  const sessionStateStore = new PersistentSessionStateStore({
    katoDir: ctx.runtimeConfig.katoDir,
  });
  const metadataList = await sessionStateStore.listSessionMetadata();
  metadataList.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const lines = metadataList
    .map((metadata) => describeSession(ctx, all, metadata))
    .filter((line): line is string => Boolean(line));

  if (lines.length === 0) {
    ctx.runtime.writeStdout(
      all ? "no sessions found\n" : "no explicit workspace attachments\n",
    );
    return;
  }

  ctx.runtime.writeStdout(`${lines.join("\n")}\n`);
}
