import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ConversationEvent, SecretsPolicyConfig } from "@kato/shared";
import {
  createSecretsRedactor,
  redactConversationEvents,
  SECRETS_RULES,
  shannonEntropyBitsPerChar,
} from "../apps/runtime/src/mod.ts";

function makePolicy(
  overrides: Partial<SecretsPolicyConfig> = {},
): SecretsPolicyConfig {
  return {
    mode: overrides.mode ?? "redact",
    disabledRules: overrides.disabledRules ?? [],
    allowlist: overrides.allowlist ?? [],
  };
}

function redact(text: string, overrides: Partial<SecretsPolicyConfig> = {}) {
  return createSecretsRedactor(makePolicy(overrides)).processText(text);
}

// --- true positives per rule class ---

const TRUE_POSITIVES: Array<{ ruleId: string; text: string }> = [
  {
    ruleId: "aws-access-key-id",
    text: "creds: AKIAIOSFODNN7EXAMPLE region us-east-1",
  },
  {
    ruleId: "aws-secret-access-key",
    text: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
  },
  {
    ruleId: "github-pat",
    text: "export GH_TOKEN=ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  },
  {
    ruleId: "github-fine-grained-pat",
    text: "github_pat_" + "11AAAAAAA0" + "a".repeat(72) + " in env",
  },
  {
    ruleId: "gitlab-pat",
    text: "token glpat-AbCdEfGhIjKlMnOpQrSt pushed",
  },
  {
    ruleId: "slack-token",
    text: "slack: xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
  },
  {
    ruleId: "slack-webhook-url",
    text:
      "post to https://hooks.slack.com/services/T0000000/B0000000/XXXXXXXXXXXXXXXXXXXXXXXX now",
  },
  {
    ruleId: "stripe-api-key",
    text: "STRIPE_KEY=sk_live_AbCdEf0123456789AbCdEf01",
  },
  {
    ruleId: "openai-api-key",
    text: "OPENAI_API_KEY=sk-AbCdEf012345T3BlbkFJAbCdEf0123456789",
  },
  {
    ruleId: "anthropic-api-key",
    text: "key sk-ant-api03-" + "Zx9_".repeat(20) + "AA",
  },
  {
    ruleId: "google-api-key",
    text: "maps key AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1v",
  },
  {
    ruleId: "npm-access-token",
    text:
      "//registry.npmjs.org/:_authToken=npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  },
  {
    ruleId: "sendgrid-api-token",
    text: "SG." + "a1B2c3D4e5F6g7H8i9J0k1" + "." +
      "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V",
  },
  {
    ruleId: "telegram-bot-token",
    text: "bot 1234567890:AAAbCdEfGhIjKlMnOpQrStUvWxYz0123456",
  },
  {
    ruleId: "huggingface-token",
    text: "hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567 for hub",
  },
  {
    ruleId: "private-key",
    text:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\nmore\n-----END RSA PRIVATE KEY-----",
  },
  {
    ruleId: "jwt",
    text: "Set token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
  },
  {
    ruleId: "url-credentials",
    text: "connect postgres://admin:Sup3rS3cret@db.internal:5432/app",
  },
  {
    ruleId: "authorization-bearer",
    text: "Authorization: Bearer AbCd01efGh23ijKl45mnOp67qrStUvWxYz89",
  },
  {
    ruleId: "generic-password-assignment",
    text: "login with password=hunter2x then proceed",
  },
  {
    ruleId: "generic-api-key-assignment",
    text: "api_key = q7Zp3xN9vR2mK8wL5tY1cF6hD4sG0jBu",
  },
];

for (const { ruleId, text } of TRUE_POSITIVES) {
  Deno.test(`secrets redaction detects and redacts ${ruleId}`, () => {
    const result = redact(text);
    assertEquals(
      result.matches.some((match) => match.ruleId === ruleId),
      true,
      `expected ${ruleId} in ${JSON.stringify(result.matches)} for: ${text}`,
    );
    assertStringIncludes(result.text, `[REDACTED:${ruleId}]`);
  });
}

// --- near-miss negatives ---

const NEGATIVES: Array<{ name: string; text: string }> = [
  { name: "git commit sha", text: "fixed in 47ac577f443d3f8c0193dabc12345678" },
  {
    name: "uuid",
    text: "session id 550e8400-e29b-41d4-a716-446655440000 created",
  },
  {
    name: "ordinary prose with token word",
    text: "the parser emits a token for each keyword in the stream",
  },
  {
    name: "password placeholder",
    text: "password=<your-password-here> must be replaced",
  },
  {
    name: "password env interpolation",
    text: "password: ${DB_PASSWORD} via dotenv",
  },
  {
    name: "low-entropy api key value",
    text: "api_key = aaaaaaaaaaaaaaaaaaaaaaaa",
  },
  {
    name: "identifier-like token assignment",
    text: "token = access_token_response_field",
  },
  {
    name: "lockfile integrity-adjacent prose",
    text: "verify the registry tarball before publishing the package",
  },
  {
    name: "short numeric pin",
    text: "pwd=12345",
  },
];

for (const { name, text } of NEGATIVES) {
  Deno.test(`secrets redaction leaves clean content untouched: ${name}`, () => {
    const result = redact(text);
    assertEquals(result.matches, [], `unexpected matches for: ${text}`);
    assertEquals(result.text, text);
  });
}

// --- redaction shape ---

Deno.test("secrets redaction preserves surrounding text", () => {
  const result = redact(
    "before AKIAIOSFODNN7EXAMPLE after",
  );
  assertEquals(result.text, "before [REDACTED:aws-access-key-id] after");
});

Deno.test("secrets redaction keeps assignment prefix and redacts only the value", () => {
  const result = redact("password=Sup3rS3cret!Pass");
  assertEquals(
    result.text,
    "password=[REDACTED:generic-password-assignment]",
  );
});

Deno.test("secrets redaction handles multiple distinct secrets in one text", () => {
  const result = redact(
    "a AKIAIOSFODNN7EXAMPLE b ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 c",
  );
  assertEquals(result.matches.length, 2);
  assertStringIncludes(result.text, "[REDACTED:aws-access-key-id]");
  assertStringIncludes(result.text, "[REDACTED:github-pat]");
});

Deno.test("secrets redaction is deterministic", () => {
  const text = "password: Sup3rS3cret!Pass and AKIAIOSFODNN7EXAMPLE";
  const first = redact(text);
  const second = redact(text);
  assertEquals(first.text, second.text);
  assertEquals(first.matches, second.matches);
});

// --- modes ---

Deno.test("secrets policy mode off skips scanning", () => {
  const result = redact("AKIAIOSFODNN7EXAMPLE", { mode: "off" });
  assertEquals(result.text, "AKIAIOSFODNN7EXAMPLE");
  assertEquals(result.matches, []);
});

Deno.test("secrets policy mode detect reports matches without altering text", () => {
  const result = redact("AKIAIOSFODNN7EXAMPLE", { mode: "detect" });
  assertEquals(result.text, "AKIAIOSFODNN7EXAMPLE");
  assertEquals(result.matches, [
    { ruleId: "aws-access-key-id", count: 1 },
  ]);
});

// --- allowlist and disabled rules ---

Deno.test("secrets allowlist literal suppresses redaction", () => {
  const result = redact("docs key AKIAIOSFODNN7EXAMPLE", {
    allowlist: ["AKIAIOSFODNN7EXAMPLE"],
  });
  assertEquals(result.matches, []);
  assertStringIncludes(result.text, "AKIAIOSFODNN7EXAMPLE");
});

Deno.test("secrets allowlist regex suppresses redaction", () => {
  const result = redact("docs key AKIAIOSFODNN7EXAMPLE", {
    allowlist: ["/EXAMPLE$/"],
  });
  assertEquals(result.matches, []);
});

Deno.test("secrets disabledRules skips a rule", () => {
  const result = redact("AKIAIOSFODNN7EXAMPLE", {
    disabledRules: ["aws-access-key-id"],
  });
  assertEquals(result.matches, []);
  assertEquals(result.text, "AKIAIOSFODNN7EXAMPLE");
});

// --- rule hygiene ---

Deno.test("secrets rules have unique ids and global+indices flags", () => {
  const seen = new Set<string>();
  for (const rule of SECRETS_RULES) {
    assertEquals(seen.has(rule.id), false, `duplicate rule id ${rule.id}`);
    seen.add(rule.id);
    assertEquals(rule.pattern.global, true, `${rule.id} missing g flag`);
    assertEquals(rule.pattern.hasIndices, true, `${rule.id} missing d flag`);
    assertEquals(rule.keywords.length > 0, true, `${rule.id} needs keywords`);
    for (const keyword of rule.keywords) {
      assertEquals(
        keyword,
        keyword.toLowerCase(),
        `${rule.id} keyword must be lowercase`,
      );
    }
  }
});

Deno.test("shannon entropy distinguishes random from repeated strings", () => {
  assertEquals(shannonEntropyBitsPerChar("aaaaaaaa") < 0.1, true);
  assertEquals(
    shannonEntropyBitsPerChar("q7Zp3xN9vR2mK8wL5tY1cF6hD4sG0jBu") > 3.5,
    true,
  );
});

// --- event transform ---

function makeUserEvent(content: string, eventId = "evt-1"): ConversationEvent {
  return {
    eventId,
    provider: "claude",
    sessionId: "session-1",
    kind: "message.user",
    role: "user",
    content,
    source: { providerEventType: "user" },
  };
}

Deno.test("redactConversationEvents redacts message content", () => {
  const redactor = createSecretsRedactor(makePolicy());
  const result = redactConversationEvents(
    [makeUserEvent("my key is AKIAIOSFODNN7EXAMPLE")],
    redactor,
  );
  assertEquals(result.droppedEventIds, []);
  assertEquals(result.redactedEvents, [{
    eventId: "evt-1",
    matches: [{ ruleId: "aws-access-key-id", count: 1 }],
  }]);
  const event = result.events[0];
  assertEquals(event?.kind, "message.user");
  if (event?.kind === "message.user") {
    assertEquals(event.content, "my key is [REDACTED:aws-access-key-id]");
  }
});

Deno.test("redactConversationEvents walks tool call input deeply", () => {
  const redactor = createSecretsRedactor(makePolicy());
  const toolCall: ConversationEvent = {
    eventId: "evt-2",
    provider: "claude",
    sessionId: "session-1",
    kind: "tool.call",
    toolCallId: "call-1",
    name: "Bash",
    input: {
      command: "export AWS_KEY=AKIAIOSFODNN7EXAMPLE && deploy",
      nested: {
        values: [
          "plain",
          "token xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
        ],
      },
      retries: 3,
    },
    source: { providerEventType: "tool_use" },
  };
  const result = redactConversationEvents([toolCall], redactor);
  const event = result.events[0];
  assertEquals(event?.kind, "tool.call");
  if (event?.kind === "tool.call") {
    const input = event.input as {
      command: string;
      nested: { values: string[] };
      retries: number;
    };
    assertStringIncludes(input.command, "[REDACTED:aws-access-key-id]");
    assertStringIncludes(input.nested.values[1]!, "[REDACTED:slack-token]");
    assertEquals(input.nested.values[0], "plain");
    assertEquals(input.retries, 3);
  }
  assertEquals(result.redactedEvents.length, 1);
  assertEquals(result.redactedEvents[0]?.matches.length, 2);
});

Deno.test("redactConversationEvents redacts tool results", () => {
  const redactor = createSecretsRedactor(makePolicy());
  const toolResult: ConversationEvent = {
    eventId: "evt-3",
    provider: "codex",
    sessionId: "session-1",
    kind: "tool.result",
    toolCallId: "call-1",
    result: "DB_PASSWORD=Sup3rS3cret!Pass\nAPI_URL=https://api.example.com",
    source: { providerEventType: "tool_result" },
  };
  const result = redactConversationEvents([toolResult], redactor);
  const event = result.events[0];
  if (event?.kind === "tool.result") {
    assertStringIncludes(
      event.result,
      "[REDACTED:generic-password-assignment]",
    );
    assertStringIncludes(event.result, "API_URL=https://api.example.com");
  }
});

Deno.test("redactConversationEvents in detect mode reports but keeps content", () => {
  const redactor = createSecretsRedactor(makePolicy({ mode: "detect" }));
  const result = redactConversationEvents(
    [makeUserEvent("key AKIAIOSFODNN7EXAMPLE")],
    redactor,
  );
  const event = result.events[0];
  if (event?.kind === "message.user") {
    assertEquals(event.content, "key AKIAIOSFODNN7EXAMPLE");
  }
  assertEquals(result.redactedEvents.length, 1);
});

Deno.test("redactConversationEvents in off mode passes events through", () => {
  const redactor = createSecretsRedactor(makePolicy({ mode: "off" }));
  const events = [makeUserEvent("key AKIAIOSFODNN7EXAMPLE")];
  const result = redactConversationEvents(events, redactor);
  assertEquals(result.events, events);
  assertEquals(result.redactedEvents, []);
});

Deno.test("redactConversationEvents leaves kato commands intact", () => {
  const redactor = createSecretsRedactor(makePolicy());
  const result = redactConversationEvents(
    [makeUserEvent("::capture-My.Proj notes/capture.md\nplease continue")],
    redactor,
  );
  const event = result.events[0];
  if (event?.kind === "message.user") {
    assertEquals(
      event.content,
      "::capture-My.Proj notes/capture.md\nplease continue",
    );
  }
});
