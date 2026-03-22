const AUTH_EXPIRY_STATE_KEY = "__katoWebAuthExpiryState";
export const AUTH_EXPIRY_BROADCAST_CHANNEL_NAME = "kato-web-auth-expired";
export const AUTH_EXPIRY_STORAGE_KEY = "kato.web.auth-expired";
export const AUTH_EXPIRY_REDIRECT_PATH = "/login";

interface AuthExpiryState {
  signaled: boolean;
}

interface AuthExpirySignal {
  type: "auth-expired";
  redirectPath: string;
  signaledAtMs: number;
}

interface StorageSignalEvent {
  key: string | null;
  newValue: string | null;
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
}

export interface AuthExpiryEnvironment {
  root?: Record<string, unknown>;
  location?: Pick<Location, "pathname" | "replace">;
  localStorage?: Pick<Storage, "setItem">;
  addEventListener?: (
    type: "storage",
    listener: (event: StorageSignalEvent) => void,
  ) => void;
  removeEventListener?: (
    type: "storage",
    listener: (event: StorageSignalEvent) => void,
  ) => void;
  createBroadcastChannel?: (name: string) => BroadcastChannelLike;
  now?: () => number;
  redirectPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAuthExpiryState(root: Record<string, unknown>): AuthExpiryState {
  const existing = root[AUTH_EXPIRY_STATE_KEY];
  if (isRecord(existing) && typeof existing["signaled"] === "boolean") {
    return existing as unknown as AuthExpiryState;
  }

  const state: AuthExpiryState = { signaled: false };
  root[AUTH_EXPIRY_STATE_KEY] = state;
  return state;
}

function resolveEnvironment(
  options: AuthExpiryEnvironment = {},
):
  & Required<Pick<AuthExpiryEnvironment, "root" | "now" | "redirectPath">>
  & Pick<
    AuthExpiryEnvironment,
    | "location"
    | "localStorage"
    | "addEventListener"
    | "removeEventListener"
    | "createBroadcastChannel"
  > {
  const root = options.root ?? globalThis as unknown as Record<string, unknown>;
  const location = options.location ??
    (typeof globalThis.location === "object" ? globalThis.location : undefined);
  const localStorage = options.localStorage ??
    (typeof globalThis.localStorage === "object"
      ? globalThis.localStorage
      : undefined);
  const addEventListener = options.addEventListener ??
    (typeof globalThis.addEventListener === "function"
      ? globalThis.addEventListener.bind(globalThis) as (
        type: "storage",
        listener: (event: StorageSignalEvent) => void,
      ) => void
      : undefined);
  const removeEventListener = options.removeEventListener ??
    (typeof globalThis.removeEventListener === "function"
      ? globalThis.removeEventListener.bind(globalThis) as (
        type: "storage",
        listener: (event: StorageSignalEvent) => void,
      ) => void
      : undefined);
  const createBroadcastChannel = options.createBroadcastChannel ??
    (typeof BroadcastChannel === "function"
      ? (name: string) => new BroadcastChannel(name)
      : undefined);

  return {
    root,
    location,
    localStorage,
    addEventListener,
    removeEventListener,
    createBroadcastChannel,
    now: options.now ?? (() => Date.now()),
    redirectPath: options.redirectPath ?? AUTH_EXPIRY_REDIRECT_PATH,
  };
}

function buildAuthExpirySignal(
  env: ReturnType<typeof resolveEnvironment>,
): AuthExpirySignal {
  return {
    type: "auth-expired",
    redirectPath: env.redirectPath,
    signaledAtMs: env.now(),
  };
}

function parseAuthExpirySignal(value: unknown): AuthExpirySignal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value["type"] !== "auth-expired") {
    return undefined;
  }
  if (typeof value["redirectPath"] !== "string") {
    return undefined;
  }
  if (
    typeof value["signaledAtMs"] !== "number" ||
    !Number.isFinite(value["signaledAtMs"])
  ) {
    return undefined;
  }
  return {
    type: "auth-expired",
    redirectPath: value["redirectPath"],
    signaledAtMs: value["signaledAtMs"],
  };
}

function parseStoredAuthExpirySignal(
  value: string | null,
): AuthExpirySignal | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return parseAuthExpirySignal(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

export function redirectToLogin(
  options: AuthExpiryEnvironment = {},
): void {
  const env = resolveEnvironment(options);
  if (!env.location || env.location.pathname === env.redirectPath) {
    return;
  }
  env.location.replace(env.redirectPath);
}

export function signalAuthExpired(
  options: AuthExpiryEnvironment = {},
): boolean {
  const env = resolveEnvironment(options);
  const state = getAuthExpiryState(env.root);
  if (state.signaled) {
    return false;
  }

  state.signaled = true;
  const signal = buildAuthExpirySignal(env);

  try {
    const channel = env.createBroadcastChannel?.(
      AUTH_EXPIRY_BROADCAST_CHANNEL_NAME,
    );
    channel?.postMessage(signal);
    channel?.close();
  } catch {
    // Ignore broadcast failures and continue with fallback behavior.
  }

  try {
    env.localStorage?.setItem(
      AUTH_EXPIRY_STORAGE_KEY,
      JSON.stringify(signal),
    );
  } catch {
    // Ignore storage failures; current-tab redirect still happens.
  }

  redirectToLogin(env);
  return true;
}

export function listenForAuthExpiry(
  onExpire: () => void,
  options: AuthExpiryEnvironment = {},
): () => void {
  const env = resolveEnvironment(options);
  const state = getAuthExpiryState(env.root);
  let active = true;

  const maybeHandleSignal = (signal: AuthExpirySignal | undefined) => {
    if (!active || !signal || signal.redirectPath !== env.redirectPath) {
      return;
    }
    if (state.signaled) {
      return;
    }
    state.signaled = true;
    onExpire();
  };

  const onMessage = (event: MessageEvent) => {
    maybeHandleSignal(parseAuthExpirySignal(event.data));
  };
  const channel = (() => {
    try {
      return env.createBroadcastChannel?.(AUTH_EXPIRY_BROADCAST_CHANNEL_NAME);
    } catch {
      return undefined;
    }
  })();
  channel?.addEventListener("message", onMessage);

  const onStorage = (event: StorageSignalEvent) => {
    if (event.key !== AUTH_EXPIRY_STORAGE_KEY) {
      return;
    }
    maybeHandleSignal(parseStoredAuthExpirySignal(event.newValue));
  };
  env.addEventListener?.("storage", onStorage);

  return () => {
    active = false;
    channel?.removeEventListener("message", onMessage);
    channel?.close();
    env.removeEventListener?.("storage", onStorage);
  };
}
