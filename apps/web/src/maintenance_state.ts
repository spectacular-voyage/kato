export const DEFAULT_TWINS_DAYS = 30;

export interface MaintenanceHiddenField {
  name: string;
  value: string;
}

export function parseTwinsDays(value: FormDataEntryValue | null): number {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) {
    throw new Error("Twin cleanup days is required");
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      "Twin cleanup days must be a whole number greater than or equal to 0",
    );
  }
  return parsed;
}

export function resolveTwinsDaysParam(raw: string | null): number {
  const normalized = raw?.trim();
  if (!normalized) {
    return DEFAULT_TWINS_DAYS;
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_TWINS_DAYS;
  }
  return parsed;
}

export function buildMaintenanceHiddenFields(options: {
  includeStale: boolean;
  workspaceFilter?: string;
  twinsDays?: number;
  deleteTwinMetadata?: boolean;
}): MaintenanceHiddenField[] {
  const fields: MaintenanceHiddenField[] = [{
    name: "includeStale",
    value: options.includeStale ? "true" : "false",
  }];
  const workspaceFilter = options.workspaceFilter?.trim();
  if (workspaceFilter) {
    fields.push({
      name: "workspaceFilter",
      value: workspaceFilter,
    });
  }
  if (options.twinsDays !== undefined) {
    fields.push({
      name: "twinsDays",
      value: String(options.twinsDays),
    });
  }
  if (options.deleteTwinMetadata) {
    fields.push({
      name: "deleteTwinMetadata",
      value: "on",
    });
  }
  return fields;
}
