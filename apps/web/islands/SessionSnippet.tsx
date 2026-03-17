import { useEffect, useState } from "preact/hooks";

interface SessionSnippetProps {
  sessionId: string;
  snippet?: string;
  allowSourceReplay?: boolean;
  snippetClass?: string;
  title?: string;
}

interface SessionSnippetResponse {
  sessionId: string;
  status: "ready" | "unavailable";
  snippet?: string;
}

type SnippetState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; snippet: string }
  | { status: "unavailable" };

function storageKey(sessionId: string): string {
  return `kato:revealed-snippet:${sessionId}`;
}

function normalizeSnippet(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readCachedSnippet(sessionId: string): string | undefined {
  try {
    return normalizeSnippet(
      globalThis.localStorage?.getItem(storageKey(sessionId)) ?? undefined,
    );
  } catch {
    return undefined;
  }
}

function cacheSnippet(sessionId: string, snippet: string): void {
  try {
    globalThis.localStorage?.setItem(storageKey(sessionId), snippet);
  } catch {
    // Ignore storage failures; the reveal still succeeds for the current view.
  }
}

function buildSnippetState(snippet: string | undefined): SnippetState {
  const normalized = normalizeSnippet(snippet);
  return normalized
    ? { status: "ready", snippet: normalized }
    : { status: "idle" };
}

export default function SessionSnippet(props: SessionSnippetProps) {
  const [state, setState] = useState<SnippetState>(() =>
    buildSnippetState(props.snippet)
  );

  useEffect(() => {
    const directSnippet = normalizeSnippet(props.snippet);
    if (directSnippet) {
      cacheSnippet(props.sessionId, directSnippet);
      setState({ status: "ready", snippet: directSnippet });
      return;
    }
    const cachedSnippet = readCachedSnippet(props.sessionId);
    setState(
      cachedSnippet
        ? { status: "ready", snippet: cachedSnippet }
        : { status: "idle" },
    );
  }, [props.sessionId, props.snippet]);

  if (state.status === "ready") {
    return (
      <span class={props.snippetClass} title={props.title}>
        {state.snippet}
      </span>
    );
  }

  if (state.status === "loading") {
    return (
      <span class="muted mono" title={props.title}>
        loading snippet...
      </span>
    );
  }

  if (state.status === "unavailable") {
    return (
      <span class="muted mono" title={props.title}>
        snippet unavailable
      </span>
    );
  }

  const loadSnippet = async () => {
    setState({ status: "loading" });
    try {
      const url = new URL(
        "/api/session-snippet",
        globalThis.location?.origin ?? "http://kato.local",
      );
      url.searchParams.set("sessionId", props.sessionId);
      if (props.allowSourceReplay !== false) {
        url.searchParams.set("source", "1");
      }
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
        },
      });
      if (!response.ok) {
        setState({ status: "unavailable" });
        return;
      }
      const payload = await response.json() as SessionSnippetResponse;
      if (payload.status === "ready" && normalizeSnippet(payload.snippet)) {
        const snippet = normalizeSnippet(payload.snippet)!;
        cacheSnippet(props.sessionId, snippet);
        setState({
          status: "ready",
          snippet,
        });
        return;
      }
      setState({ status: "unavailable" });
    } catch {
      setState({ status: "unavailable" });
    }
  };

  return (
    <button
      type="button"
      class="mono session-inline-action"
      title={props.title}
      onClick={() => void loadSnippet()}
    >
      show snippet
    </button>
  );
}
