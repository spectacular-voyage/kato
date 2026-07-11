---
id: 4gjs97k6wxfy0q0kobh2daqp
title: 'Release Notes v0.2.13'
desc: Default-on secrets redaction, safer replay/export behavior, expanded user documentation, and npm package metadata polish.
updated: 1781195549137
created: 1781195549137
---

## Summary

`v0.2.13` is a security and documentation release. Kato now redacts common credential patterns by default before Kato-created artifacts are persisted or served, including twins, recordings, exports, web snippets, and replay-derived history. The release also tightens replay/export paths so older persisted twins are sanitized before reuse, expands the user guide into focused topic pages, and polishes npm package metadata for the generated wrapper packages.

## User-facing Changes

- Secrets redaction is enabled by default. Kato scans captured conversation events for high-signal credential patterns such as vendor API keys, PEM private keys, JWTs, bearer tokens, URL credentials, and `password=` / `api_key=`-style assignments.
- Detected secrets are replaced with deterministic `[REDACTED:<rule-id>]` placeholders before Kato writes twins, recordings, or exports, and before replay-derived snippets are served in Kato Web.
- Redaction activity is recorded in the security audit log with rule/count metadata only. Matched secret text is not logged.
- The shared config now supports `secretsPolicy` in `~/.kato/shared/kato-shared-config.yaml`:

  ```yaml
  secretsPolicy:
    mode: redact
    disabledRules: []
    allowlist: []
  ```

- `mode: detect` logs detections without changing output, while `mode: off` disables Kato's redaction pass. Missing config defaults to `redact`.
- Kato Web and daemon export paths now re-sanitize legacy twin-backed history during replay, reducing the chance that older unredacted twins resurface in snippets or exports after upgrade.
- Session snippets are pinned to the source-head first user message during ingestion so restart/replay bookkeeping is less likely to change the displayed session label.
- Kato Web `New capture` and `New recording` popovers can set an output title and filename snippet before the output file is created. Title changes derive the filename snippet until the snippet is manually customized.
- `kato restart` now also restarts Kato Web when web config exists, so daemon and web processes are less likely to drift across local upgrades.
- The user guide has been expanded into focused pages for installation, quickstart, recording, web, workspaces, configuration, and troubleshooting.
- README coverage now includes install/upgrade guidance, supported platforms, secrets redaction behavior, and local web startup basics.

### Upgrade notes

- Existing provider-owned transcript/session files are not modified by Kato. Redaction applies to Kato-created outputs and replay-derived views.
- Existing Kato-created files that were written before this release are not rewritten in place. When older twin history is loaded for snippets or export, it is sanitized before being returned.
- If a legitimate value is over-redacted, add a literal substring or `/regex/` entry to `secretsPolicy.allowlist`, or temporarily use `mode: detect` while tuning rules.
- `secretsPolicy.mode: null` is rejected as invalid config. Omit `mode` to use the default `redact` behavior.

## Developer-oriented Changes

- Secrets detection/redaction lives in the Deno-native runtime policy layer, with vendor-pattern rules adapted from high-signal scanner rules, structural PEM/JWT checks, and entropy-guarded generic assignment rules.
- Live ingestion and provider source replay both apply the secrets policy at the `ConversationEvent` parse boundary; redaction failures drop affected events fail-closed.
- Replay audit payloads now stay aggregate-only for `secrets.redacted` / `secrets.detected`; stable dropped event identifiers are not included in those audit records.
- Runtime config validation rejects malformed `secretsPolicy` values, including explicit `mode: null`, and test coverage was added for defaults, invalid values, allowlists, disabled rules, and all-rule-disabled scanning.
- Benchmarks were added under `tests/secrets-redaction_bench.ts` for detector microbenchmarks and parse/replay overhead baselines.
- Credential-shaped test fixtures are built from split literals so repository push protection does not see contiguous fake secrets.
- CodeRabbit path instructions now tell automated review to respect Dendron `updated` frontmatter in `documentation/notes/**`.
- npm package assembly now uses the public Kato homepage consistently and improves generated top-package README content.
- Kato Web now pins Vite to a patched 7.3.x release so `deno task audit` passes the high-severity gate.
- Session output metadata now includes `filenameSlug`, and generated workspace paths can use it as an explicit `{snippetSlug}` source before falling back to the extracted session snippet.
