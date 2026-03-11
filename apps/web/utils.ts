import { createDefine } from "fresh";

export interface State {
  appName: string;
  authenticated: boolean;
  csrfToken?: string;
}

export const define = createDefine<State>();
