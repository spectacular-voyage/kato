# Security Policy

## Supported Versions

Kato supports security fixes for the current minor release line only.

| Release line | Supported |
| --- | --- |
| Current minor release line | Yes |
| Older minor release lines | No |
| Unreleased builds from `main` | Best effort only |

For example, while the latest release is `0.2.x`, security fixes are released on the `0.2.x` line. When Kato moves to `0.3.0`, `0.3.x` becomes the supported line and `0.2.x` is no longer supported unless a separate backport is explicitly announced.

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

Use GitHub's [private vulnerability reporting](https://github.com/spectacular-voyage/kato/security/advisories/new) for this repository. If that link is unavailable, contact the maintainer privately before sharing details publicly.

Useful reports include:

- affected Kato version
- operating system
- install source, such as npm, pnpm, or a GitHub release bundle
- clear impact statement
- reproduction steps or proof of concept
- relevant logs with secrets, tokens, private chats, and local paths redacted where possible

Kato handles local chat/session data, filesystem writes, command parsing, and secret redaction. Please avoid sending real private conversations, credentials, API keys, or production-only data in the initial report.

Reports generated only by automated scanners, without a demonstrated Kato-specific impact, may be closed without detailed response. Kato does not currently operate a bug bounty program.

## Response Expectations

The maintainer will try to acknowledge valid-looking vulnerability reports within 7 days. Accepted vulnerabilities will be investigated privately, fixed on the supported release line, and disclosed after a patched release is available. Reports may be declined when they do not affect Kato, require unrealistic local access assumptions, duplicate an existing report, or lack enough information to reproduce or evaluate the issue.
