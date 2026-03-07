import { createDefine } from "fresh";
import type { WebConfig } from "@kato/shared";

export interface State {
  appName: string;
  webConfig?: WebConfig;
  authenticated: boolean;
  csrfToken?: string;
}

export const define = createDefine<State>();
