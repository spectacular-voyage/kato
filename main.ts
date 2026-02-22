import { describeDaemonEntryPoint } from "./apps/daemon/src/mod.ts";

export function describeWorkspaceLayout(): string {
  return [
    "apps/daemon",
    "apps/web",
    "apps/cloud",
    "shared/src",
  ].join(", ");
}

export function describeRuntime(): string {
  return describeDaemonEntryPoint();
}

if (import.meta.main) {
  console.log(describeRuntime());
}
