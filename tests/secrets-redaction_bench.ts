/**
 * Secrets redaction timing suite.
 *
 * Run with: deno task bench
 *
 * Establishes the overhead of the secrets policy on the ingestion hot path:
 * - detector micro-benchmarks (clean vs secret-laden content, three sizes,
 *   off/detect/redact modes, prefilter hit vs miss)
 * - end-to-end provider source replay (real Claude parser) with mode off vs
 *   redact, to express redaction as a share of total parse cost
 */

import type { ConversationEvent, SecretsPolicyConfig } from "@kato/shared";
import {
  createSecretsRedactor,
  redactConversationEvents,
  replayProviderSourceEvents,
} from "../apps/runtime/src/mod.ts";
import { join } from "@std/path";

function makePolicy(mode: SecretsPolicyConfig["mode"]): SecretsPolicyConfig {
  return { mode, disabledRules: [], allowlist: [] };
}

// Deterministic pseudo-random content so runs are comparable.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const WORDS = [
  "the",
  "parser",
  "emits",
  "events",
  "for",
  "each",
  "provider",
  "session",
  "while",
  "kato",
  "appends",
  "twin",
  "records",
  "and",
  "renders",
  "markdown",
  "output",
  "with",
  "policy",
  "gates",
];

function makeCleanText(targetBytes: number, seed: number): string {
  const rng = makeRng(seed);
  const parts: string[] = [];
  let size = 0;
  while (size < targetBytes) {
    const word = WORDS[Math.floor(rng() * WORDS.length)]!;
    parts.push(word);
    size += word.length + 1;
    if (rng() < 0.08) {
      parts.push("\n");
    }
  }
  return parts.join(" ");
}

function plantSecrets(text: string, count: number): string {
  const lines = text.split("\n");
  const step = Math.max(1, Math.floor(lines.length / (count + 1)));
  for (let i = 0; i < count; i += 1) {
    const index = Math.min(lines.length - 1, (i + 1) * step);
    lines[index] = `${
      lines[index] ?? ""
    } AKIAIOSFODNN7EXAMPLE and password=Sup3rS3cret!${i}`;
  }
  return lines.join("\n");
}

const SIZES: Array<{ label: string; bytes: number }> = [
  { label: "1KB", bytes: 1_024 },
  { label: "32KB", bytes: 32_768 },
  { label: "256KB", bytes: 262_144 },
];

const CLEAN_TEXTS = new Map(
  SIZES.map(({ label, bytes }) => [label, makeCleanText(bytes, 42)]),
);
const SECRET_TEXTS = new Map(
  SIZES.map((
    { label },
  ) => [label, plantSecrets(CLEAN_TEXTS.get(label)!, 8)]),
);

const offRedactor = createSecretsRedactor(makePolicy("off"));
const detectRedactor = createSecretsRedactor(makePolicy("detect"));
const redactRedactor = createSecretsRedactor(makePolicy("redact"));

for (const { label } of SIZES) {
  const clean = CLEAN_TEXTS.get(label)!;
  const secrets = SECRET_TEXTS.get(label)!;

  Deno.bench(`processText off ${label} (baseline passthrough)`, {
    group: `text-${label}`,
    baseline: true,
  }, () => {
    offRedactor.processText(clean);
  });

  Deno.bench(`processText redact ${label} clean content`, {
    group: `text-${label}`,
  }, () => {
    redactRedactor.processText(clean);
  });

  Deno.bench(`processText detect ${label} secret-laden`, {
    group: `text-${label}`,
  }, () => {
    detectRedactor.processText(secrets);
  });

  Deno.bench(`processText redact ${label} secret-laden`, {
    group: `text-${label}`,
  }, () => {
    redactRedactor.processText(secrets);
  });
}

// --- event-transform benchmark over a synthetic transcript ---

function makeTranscript(eventCount: number, withSecrets: boolean) {
  const events: ConversationEvent[] = [];
  for (let i = 0; i < eventCount; i += 1) {
    const base = {
      eventId: `evt-${i}`,
      provider: "bench",
      sessionId: "bench-session",
      source: { providerEventType: "bench" },
    };
    if (i % 4 === 3) {
      events.push({
        ...base,
        kind: "tool.result",
        toolCallId: `call-${i}`,
        result: withSecrets && i % 8 === 7
          ? plantSecrets(makeCleanText(2_048, i), 1)
          : makeCleanText(2_048, i),
      } as ConversationEvent);
    } else {
      events.push({
        ...base,
        kind: i % 2 === 0 ? "message.user" : "message.assistant",
        role: i % 2 === 0 ? "user" : "assistant",
        content: makeCleanText(512, i),
      } as unknown as ConversationEvent);
    }
  }
  return events;
}

const CLEAN_TRANSCRIPT = makeTranscript(200, false);
const SECRET_TRANSCRIPT = makeTranscript(200, true);

Deno.bench("redactConversationEvents off 200 events (baseline)", {
  group: "events",
  baseline: true,
}, () => {
  redactConversationEvents(CLEAN_TRANSCRIPT, offRedactor);
});

Deno.bench("redactConversationEvents redact 200 clean events", {
  group: "events",
}, () => {
  redactConversationEvents(CLEAN_TRANSCRIPT, redactRedactor);
});

Deno.bench("redactConversationEvents redact 200 events w/ secrets", {
  group: "events",
}, () => {
  redactConversationEvents(SECRET_TRANSCRIPT, redactRedactor);
});

// --- end-to-end: real Claude parser replay, off vs redact ---

const replayDir = await Deno.makeTempDir({ prefix: "kato-secrets-bench-" });
const replayPath = join(replayDir, "session-bench.jsonl");
{
  const lines: string[] = [];
  for (let i = 0; i < 500; i += 1) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const text = i % 10 === 9
      ? plantSecrets(makeCleanText(1_024, i), 1)
      : makeCleanText(1_024, i);
    lines.push(JSON.stringify({
      type: role,
      uuid: `m-${i}`,
      timestamp: new Date(1781430000000 + i * 1000).toISOString(),
      message: {
        role,
        ...(role === "assistant" ? { model: "claude-opus-4-6" } : {}),
        content: [{ type: "text", text }],
      },
    }));
  }
  await Deno.writeTextFile(replayPath, lines.join("\n") + "\n");
}

const replayMetadata = {
  provider: "claude",
  providerSessionId: "session-bench",
  sourceFilePath: replayPath,
};

Deno.bench("claude replay 500 events, mode off (parse only)", {
  group: "replay",
  baseline: true,
}, async () => {
  await replayProviderSourceEvents(replayMetadata, {
    secretsPolicy: makePolicy("off"),
  });
});

Deno.bench("claude replay 500 events, mode redact", {
  group: "replay",
}, async () => {
  await replayProviderSourceEvents(replayMetadata, {
    secretsPolicy: makePolicy("redact"),
  });
});
