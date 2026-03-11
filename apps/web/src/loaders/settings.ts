import { loadUserSettings } from "@kato/runtime";

export async function loadSettingsPageData() {
  return await loadUserSettings();
}
