---
id: how-do-we-add-wikilink-r-d38746da
title: 'How do we add wikilink roots to a workspace?'
desc: ''
created: 1778171143414
updated: 1778171143414
participants: [djradon, codex.gpt-5.5]
kato-sessionIds: [019e0152-3681-77e0-9fef-c58188fa8052]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [d38746da-3c73-4888-a5c8-5d839b37ebcd]
conversationEventKinds: [message.assistant, message.user, tool.call, tool.result]
---

# djradon_2026-05-07_0023_56

How do we add wikilink roots to a workspace?

# gpt-5.5_2026-05-07_0024_02

I’ll check the repo guidance first, then look for the workspace/wiki-link code paths so the answer matches the current implementation.

The guidance confirms developer notes are the source of truth here. The broad search is noisy, so I’m narrowing to the config schema and writer implementation that actually define wikilink roots.

Kato does not have a separate `wikilinkRoots` workspace config key right now. Wikilink roots are derived automatically from `dendron.yml` when this workspace flag is enabled:

```yaml
workspaceFeatureFlags:
  writerUseDendronStyleWikilinks: true
```

Put that in the workspace’s `.kato-workspace-config.yaml`.

Then make sure the recording output path lives inside a Dendron vault declared in an ancestor `dendron.yml`. Example:

```yaml
workspace:
  vaults:
    - fsPath: .
      selfContained: true
```

For `selfContained: true`, Kato treats `<fsPath>/notes` as wikilinkable. For `selfContained: false`, it treats `<fsPath>` itself as wikilinkable. Multi-vault works too:

```yaml
workspace:
  vaults:
    - fsPath: alpha
      selfContained: true
    - fsPath: shared-notes
      selfContained: false
```

So the practical steps are:

1. Set `writerUseDendronStyleWikilinks: true` in `.kato-workspace-config.yaml`.
2. Add or update an ancestor `dendron.yml` with the vaults you want.
3. Make sure `defaultOutputDir` or the explicit recording path lands inside one of those derived note roots.

If no matching `dendron.yml` is found, Kato falls back to only wikilinking markdown files in the output file’s own directory. The implementation is in [dendron.ts](../../apps/runtime/src/workspace/dendron.ts:55), and the current decision is documented in [dev.decision-log.md](dev.decision-log.md:59).

# djradon_2026-05-07_0032_09

For /home/djradon/hub/semantic-flow/weave/dependencies/github.com/semantic-flow/weave-dev-archive,   writerUseDendronStyleWikilinks is true but the dendron.yml doesn't have all the vaults I want listed because it's actually embedded in the weave repo. 

I think either we have to allow further recursing ( e.g. to get up to /home/djradon/hub/semantic-flow/weave/dendron.yml) or manualy specification in the workspace config of additional wikilinks roots. 

What do you think?

# gpt-5.5_2026-05-07_0032_20

I’m going to look at the actual embedded path and the surrounding Dendron config so the tradeoff is grounded in how your repo is laid out, not just the current heuristic.

There is a `dendron.yml` inside the embedded archive, which matters because the current resolver stops at the first ancestor config whose derived roots contain the output. I’m checking both configs next to see whether “keep climbing” would be enough or whether this really needs an override.

This case is exactly the weak spot in the current “first matching config” rule: the embedded archive’s own config is valid, but narrower than the parent Weave workspace. I’m reading the workspace config and resolver tests once more before I give you a concrete recommendation.

I’d push against automatic “keep recursing” as the default.

In your specific case, the current resolver finds:

`/home/djradon/hub/semantic-flow/weave/dependencies/github.com/semantic-flow/weave-dev-archive/dendron.yml`

That config is valid and its `.` self-contained vault covers the output under `weave-dev-archive/notes`, so Kato stops there. The parent config at:

`/home/djradon/hub/semantic-flow/weave/dendron.yml`

has the fuller multi-vault view you want, but blindly unioning every matching ancestor changes the meaning of an embedded Dendron workspace. Sometimes a nested `dendron.yml` is intentionally narrower.

My recommendation: add explicit workspace-level wikilink context overrides, not broader recursion by default.

Something like:

```yaml
wikilinks:
  dendronConfigPath: ../../../../dendron.yml
```

or, if we want lower-level control:

```yaml
wikilinks:
  additionalRoots:
    - ../../../../documentation/notes
    - ../../semantic-flow-framework/notes
    - ../../sflo/notes
```

I slightly prefer `dendronConfigPath` as the first feature because it preserves the Dendron source of truth: Kato would parse the selected parent `dendron.yml`, derive the same vault roots it already knows how to derive, and diagnostics can clearly say “using explicit Dendron config.” `additionalRoots` is useful too, but it is more Kato-specific and easier to drift from the actual vault list.

The clean contract would be:

- default: current behavior, nearest matching Dendron context
- explicit `wikilinks.dendronConfigPath`: use that Dendron config for this workspace’s wikilink roots
- optional `wikilinks.additionalRoots`: append manual roots after Dendron-derived roots
- all paths resolve relative to `.kato-workspace-config.yaml`
- still only affects wikilink conversion, not write permission; `allowedWriteRoots` remains separate

That gives your embedded archive workspace access to the parent Weave vault graph without making nested Dendron projects surprising by default.

# djradon_2026-05-07_0038_27

I think additionalRoots is helpful, because some users might not use Dendron, and maybe a repo is embedded in multiple other repos and should use roots from all of them. I guess we do both? If you agree, please fill out [[task.2026.2026-05-07-manual-wikilink-specification]]

# gpt-5.5_2026-05-07_0038_34

I agree with doing both, with `dendronConfigPath` as “reuse an existing Dendron workspace definition” and `additionalRoots` as the explicit escape hatch for non-Dendron or multi-embedding cases. I’ll read the task note and fill it in using the repo’s task-note structure.

The new task note is still just the scaffold, so I’m going to write the contract up from scratch and keep it implementation-oriented. I’ll include the embedded-repo case as the motivating example without making Weave-specific behavior part of the product contract.

I’m editing the task note now. The plan will call out both schema shapes and a precedence rule so implementation doesn’t turn into a vague “more roots somehow” change.

The note is filled in. I’m doing a quick readback for structure and any awkward contract gaps before I close this out.

Filled out [task.2026.2026-05-07-manual-wikilink-specification.md](task.2026.2026-05-07-manual-wikilink-specification.md:1).

I wrote it around doing both:

- `wikilinks.dendronConfigPath` for explicitly selecting a parent or alternate `dendron.yml`
- `wikilinks.additionalRoots` for non-Dendron note trees, ad hoc roots, and multi-embedding cases

I also pinned the precedence rule: explicit Dendron config roots replace automatic discovery, while `additionalRoots` always append. The note rejects automatic ancestor unioning by default because nested Dendron workspaces may be intentionally narrower.
