import { createDefine } from "fresh";

export interface State {
  appName: string;
}

export const define = createDefine<State>();
