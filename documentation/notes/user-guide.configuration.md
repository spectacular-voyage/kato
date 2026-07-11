---
id: ec321820d6f340095d4e4b49
title: User Guide Configuration
desc: ""
updated: 1781200000005
created: 1781200000005
---

## Runtime Directory

Kato uses global `~/.kato` by default. Set `KATO_RUNTIME_DIR` to an absolute
path if you intentionally want a different runtime root.

Common files:

- `~/.kato/kato-user-config.yaml`
- `~/.kato/shared/kato-shared-config.yaml`
- `~/.kato/shared/status.json`
- `~/.kato/shared/ipc/daemon-control.json`
- `~/.kato/shared/sessions/*.meta.json`
- `~/.kato/shared/sessions/*.twin.jsonl`
- `~/.kato/shared/workspace-registry.json`
- `~/.kato/daemon/kato-daemon-config.yaml`
- `~/.kato/web/kato-web-config.yaml`
- `<workspace>/.kato-workspace-config.yaml`

## Secrets Redaction

Secrets redaction is configured in `~/.kato/shared/kato-shared-config.yaml`:

```yaml
secretsPolicy:
  mode: redact
  disabledRules: []
  allowlist: []
```

Modes:

- `redact`: replace detected secrets before writing Kato-owned outputs.
- `detect`: log rule/count metadata but do not replace text.
- `off`: disable Kato's redaction pass.

`allowlist` entries are literal substrings or `/regex/` patterns that should
not be redacted.

## Participant Usernames

User participant settings live in `~/.kato/kato-user-config.yaml`.

Commands:

```bash
kato user init
kato user default set <username>
kato user default clear
kato user map set <workspace-alias-or-id> <username>
kato user map list
kato user map delete <workspace-alias-or-id>
kato user exclude-me <true|false>
```

Workspace username mappings are personal settings. They do not change the
shared workspace file.

## Output Tags

Shared workspace tags live in `<workspace>/.kato-workspace-config.yaml`. `defaultTags` are automatically included in effective markdown frontmatter tags for workspace outputs, while `tagSuggestions` only feed Kato Web tag inputs.

Personal tag suggestions live in `~/.kato/kato-user-config.yaml` under `tagLibraries`. Kato Web Settings can edit global personal suggestions and per-workspace personal suggestions. Personal suggestions are not automatic defaults; they are written only when selected or typed for an output.

## Writer Settings

Shared defaults live in `~/.kato/shared/kato-shared-config.yaml`. Workspace
overrides live in `.kato-workspace-config.yaml`.

Writer flags can control whether markdown output includes commentary,
thinking, tool calls/results, decision prompts/options/selections, italicized
user messages, relative local links, and Dendron wikilinks.

Kato Web can edit registered workspace overrides from the Workspaces page, including auto-recording for Claude conversations, output directory, filename template, workspace timezone, shared default tags, shared tag suggestions, markdown frontmatter toggles, and writer flags. The editor is for shared `.kato-workspace-config.yaml` values; personal username mappings and personal tag suggestions still live in user config.

Workspace settings win for workspace-scoped recordings. Existing output files
are not renamed when config changes; future writes use the current effective
settings.

## Provider Session Roots

Provider session roots live in daemon runtime config. They define where Kato
may read provider transcript/session files for supported tools. Keep these
roots narrow and explicit.
