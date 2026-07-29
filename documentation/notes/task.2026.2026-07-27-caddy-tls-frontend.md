---
id: 20260727-caddy-tls-frontend
title: 2026 07 27 Caddy Tls Frontend
desc: ''
updated: 1785159552445
created: 1785159552445
---

## Goal

Support serving Kato Web over HTTPS for remote access, using a TLS-terminating
reverse proxy (Caddy as the reference setup) in front of the existing
plain-HTTP server. Useful when operating on an untrusted network.

## Summary

Kato Web already binds a configurable hostname (`kato web init --host`,
`kato web start --host`, `KATO_WEB_HOSTNAME`), but serves plain HTTP only.
Login is a username/password POST and the session cookie's `secure` flag is
only set when the request protocol is https, so remote plain-HTTP access sends
credentials in cleartext. `kato web start` now warns when binding a
non-loopback address.

The recommended remote setup is Kato Web on `127.0.0.1` with Caddy binding the
host IP on 443 and proxying to it. That currently breaks: the same-origin
check in `apps/web/src/auth.ts` (`isSameOriginRequest`) compares the browser's
`Origin` header (`https://...`) against the internal request URL
(`http://...`), so every POST — including login — is rejected with 403. The
cookie `secure` flag and the login redirect in `apps/web/web_app.ts` have the
same blindness.

## Work

- Add an explicit opt-in trust-proxy setting (web config flag such as
  `trustProxy`, and/or `KATO_WEB_TRUSTED_PROXY=1`). Off by default so
  forwarded headers cannot be spoofed when Kato Web is exposed directly.
- When trusted, honor `X-Forwarded-Proto` (and `X-Forwarded-Host`) in:
  - `isSameOriginRequest` origin comparison
  - session/CSRF cookie `secure` flag
  - the `/login` redirect URL construction
- Document a sample Caddyfile (`reverse_proxy 127.0.0.1:5173`), including the
  `tls internal` variant for LAN-only use without public DNS.
- Tests for the forwarded-header handling, including the untrusted default
  ignoring the headers.

## Discussion

Native TLS in `Deno.serve` (cert/key options) was considered and rejected for
now: it would put certificate provisioning, renewal, and reload inside Kato,
which a fronting proxy handles better. For personal remote access without a
proxy, binding to a Tailscale/WireGuard interface IP over plain HTTP works
today and is encrypted at the tunnel layer; `tailscale serve` is a
TLS-terminating proxy and needs the same trust-proxy support as Caddy.
