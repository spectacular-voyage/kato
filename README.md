# kato

Own your AI conversations.

## Bootstrap

```sh
deno task ci
```

## Tasks

- `deno task dev`
- `deno task dev:daemon`
- `deno task dev:web`
- `deno task dev:cloud`
- `deno task dev:root`
- `deno task fmt`
- `deno task lint`
- `deno task check`
- `deno task test`
- `deno task ci`

## Notes

- Project notes live in `dev-docs/notes`.
- The legacy `stenobot/` working tree is embedded for reference only.

## Monorepo Skeleton

- `apps/daemon/src` - daemon runtime and CLI control plane
- `apps/web/src` - read-only status surface
- `apps/cloud/src` - centralized config and aggregation services
- `shared/src` - shared contracts and cross-app types
