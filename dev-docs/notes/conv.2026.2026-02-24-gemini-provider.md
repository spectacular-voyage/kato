---
id: jbpbt3rhzhq05qoyeypzch2
title: 2026 02 24 Gemini Provider
desc: ''
updated: 1771961779685
created: 1771961779685
---

# User_2026-02-24_1106_23

Let's develop the task.2026.2026-02-22-gemini-provider.md task. Please review that and the [dev.general-guidance.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.general-guidance.md) and let me know what questions you have and issues are outstanding.

# gpt-5.3-codex_2026-02-24_1106_31

I’m reviewing the task note and the general guidance doc first, then I’ll extract concrete open questions and unresolved issues from both. I’ll start by reading those files directly and mapping requirements vs. any missing decisions.

Questions I had are now resolved. You chose:

1. Separate Gemini runner (not a shared-runner refactor).
2. Turn-level assistant normalization.
3. Add `providerSessionRoots.gemini` in config.
4. Prefer `displayContent` over raw `content` when both exist.
5. Skip Gemini `info` events for now.
6. Keep workspace-root integration out of scope for this task, and capture follow-up thoughts in [task.2026.2026-02-24-better-targeting.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-02-24-better-targeting.md).

Outstanding issues to address for the Gemini task:

1. Gemini task note is partially stale vs real files (schema variants need correction): [task.2026.2026-02-22-gemini-provider.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/task.2026.2026-02-22-gemini-provider.md:18).
2. Ingestion internals are byte-offset-centric and need Gemini-specific item-index handling: [provider_ingestion.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/provider_ingestion.ts:114), [provider_ingestion.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/provider_ingestion.ts:735), [provider_ingestion.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/provider_ingestion.ts:823).
3. Config/runtime contracts are Claude+Codex-only and must be extended for Gemini roots/read-scope: [config.ts](/home/djradon/hub/spectacular-voyage/kato/shared/src/contracts/config.ts:10), [runtime_config.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/config/runtime_config.ts:38), [launcher.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/launcher.ts:36), [main.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/main.ts:102), [router.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/cli/router.ts:223).
4. Parser/test surface is missing Gemini artifacts and behavior coverage (parser fixture tests + ingestion runner tests + launcher/config tests).
5. Docs/smoke flow still assume two providers and Codex-only smoke seed: [README.md](/home/djradon/hub/spectacular-voyage/kato/README.md:90), [dev.testing.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.testing.md:68), [dev.codebase-overview.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.codebase-overview.md:264).
6. Existing cross-provider collision risk remains (snapshot key is `sessionId` only): [ingestion_runtime.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/ingestion_runtime.ts:27), [ingestion_runtime.ts](/home/djradon/hub/spectacular-voyage/kato/apps/daemon/src/orchestrator/ingestion_runtime.ts:147), [dev.todo.md](/home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/dev.todo.md:18).

No blocking questions remain for the focused Gemini-provider scope.

# User_2026-02-24_1136_41

::export /home/djradon/hub/spectacular-voyage/kato/dev-docs/notes/conv.2026.2026-02-24-gemini-provider.md
