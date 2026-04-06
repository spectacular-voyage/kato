---
id: security-review-119b967f
title: 'security review'
desc: ''
created: 1773289593595
updated: 1773289593595
participants: [djradon, codex.gpt-5.4]
kato-sessionIds: [019ce041-e0f6-7472-a267-e88d79e8070e]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [119b967f-edae-4627-b9c4-88f02558129c]
conversationEventKinds: [message.assistant, message.user, tool.call, tool.result]
---

# djradon_2026-03-11_2116_26

security review

Claude had this:

Security Issues
1. Password hash comparison is NOT timing-safe (auth.ts:101)

return actual === config.auth.passwordHash;  // BUG: not timing-safe
timingSafeEqual is correctly defined (line 116-125) and used for CSRF tokens (line 197), but the password comparison uses plain ===. This leaks whether hashes partially match via timing. Severity is low in practice (PBKDF2 dominates the time, localhost-only) but it's still wrong given a correct implementation is already available in the same file.

2. Config file written without restricted permissions (file_store_utils.ts:17)

await Deno.writeTextFile(tempPath, value);  // inherits umask, often 644
~/.kato/web/kato-web-config.yaml contains the session secret (HMAC key for forging session cookies) and the password hash. With a typical umask of 022, this file is world-readable. It should be created with mode 0o600. Deno.writeTextFile accepts a { mode } option.

3. Password/username change does not invalidate existing sessions

Session cookies contain only {expiresAt}.{hmac} - no user identity, no credential version. If an operator runs kato web init again to change credentials, any stolen session cookie from before remains valid until its 12-hour TTL expires. Minimal fix is to include a credential version or the password hash fingerprint in the session payload.

Functional / Design Issues
4. isSameOriginRequest returns false when neither Origin nor Referer is present (auth.ts:169)

This is intentionally strict (rejecting requests with no browser context), but worth knowing: curl or any non-browser client hitting /login or a mutation route without those headers will get a 403. This is fine for the stated goals, but it should be documented and tested explicitly.

5. Config loaded from disk on every request (main.ts:49, main.ts:64)

loadWebConfigState() is called on every request. Since it uses writeTextAtomically (rename), reads are safe against corruption, but repeated disk reads for every request is unnecessary overhead. Not a security issue, but worth noting for the fast-refresh path.

6. No login rate limiting

Acknowledged by the task spec (localhost-only mitigates), but if someone misconfigures the bind address (e.g., 0.0.0.0), unlimited password guessing is possible. Since kato web init allows --hostname, this is a realistic misconfiguration. A simple counter or exponential backoff would help.

Priority
Issue	Severity
Config file world-readable (exposes session secret)	High
Password hash === instead of timingSafeEqual	Medium
Sessions survive credential rotation	Medium
No login rate limiting	Low
Config reloaded per request	Low (perf)

# gpt-5.4_2026-03-11_2116_31

Reviewing the auth, session, and config persistence paths first so I can verify the reported issues against the current tree and look for anything Claude missed.

I’ve confirmed the relevant files. Next I’m reading the web auth/session implementation and the shared atomic write helper with line numbers so I can verify each claim precisely and look for adjacent bugs.

The broad shape matches Claude’s writeup so far. I’m checking the CLI/web startup path and existing tests now, because the real review value is whether there are exploitable edges or missing coverage beyond the obvious auth helpers.

I’ve moved past the auth helpers into the mutating routes, because that’s where path handling and config writes usually hide higher-impact bugs than the cookie code itself.

I’ve verified the code paths directly. I’m running the focused web/auth/config tests once so I can separate existing behavior from missing coverage before I write the findings up.

The targeted suites are running cleanly so far, which is consistent with the problem being coverage gaps rather than broken intended behavior. I’m waiting on completion and then I’ll write up the concrete findings with line references.

**Findings**
1. High: secret-bearing web config files are created with default file permissions. [apps/runtime/src/config/file_store_utils.ts](/home/djradon/hub/spectacular-voyage/kato/apps/runtime/src/config/file_store_utils.ts#L11) writes the temp file without a restrictive `mode`, and [apps/runtime/src/config/web_config.ts](/home/djradon/hub/spectacular-voyage/kato/apps/runtime/src/config/web_config.ts#L294) uses that helper for `~/.kato/web/kato-web-config.yaml`. That file contains both `passwordHash` and `sessionSecret`, so on a typical `umask 022` it is readable by other local users.

2. Low: password-hash comparison is not constant-time. [apps/web/src/auth.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/auth.ts#L92) computes the PBKDF2 hash and then compares with `===` at line 101, even though `timingSafeEqual()` already exists in the same module at line 116. Practical impact is low on the default loopback deployment, but the implementation is still wrong.

3. Low/Medium: session cookies are not tied to credential state, only to `sessionSecret`. [apps/web/src/auth.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/auth.ts#L104) signs only the expiry timestamp, and [apps/web/src/auth.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/auth.ts#L127) validates only that HMAC. If username/password are changed in the config while `sessionSecret` stays the same, existing cookies remain valid until expiry. Claude’s concrete trigger is slightly off, though: current `kato web init` does not rotate credentials because it preserves an existing config via [apps/cli/src/commands/web.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/commands/web.ts#L171) and [apps/runtime/src/config/web_config.ts](/home/djradon/hub/spectacular-voyage/kato/apps/runtime/src/config/web_config.ts#L271).

4. Low: there is no login throttling or backoff. [apps/web/routes/login.tsx](/home/djradon/hub/spectacular-voyage/kato/apps/web/routes/login.tsx#L13) accepts unlimited attempts, and [apps/web/src/auth.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/src/auth.ts#L92) does a full PBKDF2 for each correct-username guess. This stays low-risk if the service remains on loopback, but the CLI does allow non-loopback hosts via [apps/cli/src/parser.ts](/home/djradon/hub/spectacular-voyage/kato/apps/cli/src/parser.ts#L231).

**Notes**
- I agree with Claude on the file-permission issue, the non-constant-time compare, and the lack of rate limiting.
- I agree with the session-revocation concern, but not with the specific claim that rerunning `kato web init` changes credentials; it currently does not.
- I would not count `isSameOriginRequest()` rejecting requests with no `Origin`/`Referer` as a security bug. That is intentional strictness and is already asserted in [tests/web-auth_test.ts](/home/djradon/hub/spectacular-voyage/kato/tests/web-auth_test.ts#L175).
- Reloading config on every request in [apps/web/main.ts](/home/djradon/hub/spectacular-voyage/kato/apps/web/main.ts#L43) is a perf issue, not a security finding.

Focused verification passed with:
`deno test --allow-read --allow-write=.test-tmp --allow-env=HOME,USERPROFILE,KATO_RUNTIME_DIR tests/web-auth_test.ts tests/web-config_test.ts tests/web-server-status_test.ts`

What is missing from coverage: file-mode assertions, session invalidation on auth-config changes, and login throttling behavior.

# djradon_2026-03-11_2126_19

OK, can you do coverage please?

# gpt-5.4_2026-03-11_2126_33

I’m treating this as “add regression coverage for the web/auth findings,” and I’m checking the current auth/config tests plus the session format so I can make the smallest set of code and test changes that actually closes the gaps.

# djradon_2026-03-11_2126_33

::capture-k

# gpt-5.4_2026-03-11_2126_42

I’m checking whether `::capture-k` is a repo-defined control command or a shell entry point, so I can invoke the right thing instead of guessing.

# gpt-5.4_2026-03-11_2126_48

Ignoring in-chat control command `::capture-k`.