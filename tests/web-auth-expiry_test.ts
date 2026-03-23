import { assert, assertEquals } from "@std/assert";
import {
  AUTH_EXPIRY_STORAGE_KEY,
  listenForAuthExpiry,
  redirectToLogin,
  signalAuthExpired,
} from "../apps/web/islands/auth_expiry.ts";
import { loadPolledJson } from "../apps/web/src/polled_json.ts";

type FakeLocation = {
  pathname: string;
  replaceCalls: string[];
  replace(path: string): void;
};

function makeLocation(pathname: string): FakeLocation {
  return {
    pathname,
    replaceCalls: [],
    replace(path: string) {
      this.replaceCalls.push(path);
      this.pathname = path;
    },
  };
}

function createBroadcastHub() {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  return {
    createChannel(name: string) {
      let closed = false;
      const ensureListeners = () => {
        const existing = listeners.get(name);
        if (existing) {
          return existing;
        }
        const created = new Set<(event: MessageEvent) => void>();
        listeners.set(name, created);
        return created;
      };

      return {
        postMessage(message: unknown) {
          if (closed) {
            return;
          }
          for (const listener of ensureListeners()) {
            listener(new MessageEvent("message", { data: message }));
          }
        },
        addEventListener(
          _type: "message",
          listener: (event: MessageEvent) => void,
        ) {
          ensureListeners().add(listener);
        },
        removeEventListener(
          _type: "message",
          listener: (event: MessageEvent) => void,
        ) {
          ensureListeners().delete(listener);
        },
        close() {
          closed = true;
        },
      };
    },
  };
}

function createStorageHub() {
  const listeners = new Set<
    (event: { key: string | null; newValue: string | null }) => void
  >();

  return {
    addEventListener(
      _type: "storage",
      listener: (
        event: { key: string | null; newValue: string | null },
      ) => void,
    ) {
      listeners.add(listener);
    },
    removeEventListener(
      _type: "storage",
      listener: (
        event: { key: string | null; newValue: string | null },
      ) => void,
    ) {
      listeners.delete(listener);
    },
    emit(key: string, newValue: string) {
      for (const listener of listeners) {
        listener({ key, newValue });
      }
    },
  };
}

Deno.test("signalAuthExpired broadcasts and redirects only once per tab", () => {
  const location = makeLocation("/settings");
  const root: Record<string, unknown> = {};
  let storageWrites = 0;
  let broadcastWrites = 0;

  const signaledFirst = signalAuthExpired({
    root,
    location,
    localStorage: {
      setItem() {
        storageWrites += 1;
      },
    },
    createBroadcastChannel() {
      return {
        postMessage() {
          broadcastWrites += 1;
        },
        addEventListener() {},
        removeEventListener() {},
        close() {},
      };
    },
    now: () => 123,
  });
  const signaledSecond = signalAuthExpired({
    root,
    location,
    localStorage: {
      setItem() {
        storageWrites += 1;
      },
    },
    createBroadcastChannel() {
      return {
        postMessage() {
          broadcastWrites += 1;
        },
        addEventListener() {},
        removeEventListener() {},
        close() {},
      };
    },
    now: () => 456,
  });

  assertEquals(signaledFirst, true);
  assertEquals(signaledSecond, false);
  assertEquals(location.replaceCalls, ["/login"]);
  assertEquals(storageWrites, 1);
  assertEquals(broadcastWrites, 1);
});

Deno.test("listenForAuthExpiry redirects sibling tabs on BroadcastChannel signals only once per tab", () => {
  const broadcastHub = createBroadcastHub();
  const sharedRoot: Record<string, unknown> = {};
  const location = makeLocation("/sessions");
  let callbackCount = 0;

  const cleanupA = listenForAuthExpiry(() => {
    callbackCount += 1;
    redirectToLogin({ root: sharedRoot, location });
  }, {
    root: sharedRoot,
    location,
    createBroadcastChannel: (name) => broadcastHub.createChannel(name),
  });
  const cleanupB = listenForAuthExpiry(() => {
    callbackCount += 1;
    redirectToLogin({ root: sharedRoot, location });
  }, {
    root: sharedRoot,
    location,
    createBroadcastChannel: (name) => broadcastHub.createChannel(name),
  });

  signalAuthExpired({
    root: {},
    location: makeLocation("/workspaces"),
    createBroadcastChannel: (name) => broadcastHub.createChannel(name),
    now: () => 789,
  });

  cleanupA();
  cleanupB();

  assertEquals(callbackCount, 1);
  assertEquals(location.replaceCalls, ["/login"]);
});

Deno.test("listenForAuthExpiry redirects sibling tabs on storage fallback signals", () => {
  const storageHub = createStorageHub();
  const location = makeLocation("/logs");
  let callbackCount = 0;

  const cleanup = listenForAuthExpiry(() => {
    callbackCount += 1;
    redirectToLogin({ root: {}, location });
  }, {
    root: {},
    location,
    addEventListener: (type, listener) =>
      storageHub.addEventListener(type, listener),
    removeEventListener: (type, listener) =>
      storageHub.removeEventListener(type, listener),
  });

  storageHub.emit(
    AUTH_EXPIRY_STORAGE_KEY,
    JSON.stringify({
      type: "auth-expired",
      redirectPath: "/login",
      signaledAtMs: 999,
    }),
  );

  cleanup();

  assertEquals(callbackCount, 1);
  assertEquals(location.replaceCalls, ["/login"]);
});

Deno.test("loadPolledJson returns unauthorized for 401 responses without parsing data", async () => {
  const result = await loadPolledJson<{ ok: boolean }>({
    endpoint: "/api/summary",
    fetchFn: () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "authentication required" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
  });

  assertEquals(result.kind, "unauthorized");
});

Deno.test("loadPolledJson treats no-content responses as unchanged", async () => {
  const result = await loadPolledJson<{ ok: boolean }>({
    endpoint: "/api/summary",
    fetchFn: () => Promise.resolve(new Response(null, { status: 204 })),
  });

  assertEquals(result.kind, "unchanged");
});

Deno.test("loadPolledJson surfaces unexpected http errors", async () => {
  const result = await loadPolledJson<{ ok: boolean }>({
    endpoint: "/api/summary",
    fetchFn: () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
  });

  assert(result.kind === "error");
  assertEquals(result.status, 500);
});
