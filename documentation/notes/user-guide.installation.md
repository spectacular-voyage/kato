---
id: a60f51413f8470832fc0de6a
title: User Guide Installation
desc: ''
updated: 1781200000000
created: 1781200000000
---

## Install

The primary install path is npm:

```bash
npm install -g @spectacular-voyage/kato@latest
```

With pnpm:

```bash
pnpm add -g @spectacular-voyage/kato@latest
```

The npm package installs prebuilt binaries. It does not compile Kato on your
machine.

You can also download a prebuilt bundle from GitHub Releases and put the
extracted bundle directory on your `PATH`.

Supported install targets:

- Windows x64
- macOS x64
- macOS arm64
- Linux x64 glibc

## Verify

```bash
kato --version
kato help
```

The public command is `kato`. Bundled `kato-daemon` and `kato-web` binaries are
managed by Kato.

## Upgrade

With npm:

```bash
npm install -g @spectacular-voyage/kato@latest
```

With pnpm:

```bash
pnpm update -g @spectacular-voyage/kato --latest
```

Then confirm the active binary:

```bash
kato --version
```

## One-Off Use

For one-off commands without a global install:

```bash
npx @spectacular-voyage/kato@latest help
```

## Source Development

Deno 2.x is only required when developing Kato from source. User installs do
not need Deno.
