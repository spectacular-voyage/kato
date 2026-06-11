import type {
  ConversationEvent,
  SecretsPolicyConfig,
  SecretsPolicyMode,
} from "@kato/shared";
import { SECRETS_RULES, type SecretsRule } from "./secrets_rules.ts";

export interface SecretsRuleMatchSummary {
  ruleId: string;
  count: number;
}

export interface ProcessTextResult {
  text: string;
  matches: SecretsRuleMatchSummary[];
}

export interface RedactedEventOutcome {
  eventId: string;
  matches: SecretsRuleMatchSummary[];
}

export interface ProcessEventsResult {
  events: ConversationEvent[];
  redactedEvents: RedactedEventOutcome[];
  /** Events the transform failed on; never passed through unredacted. */
  droppedEventIds: string[];
}

const PLACEHOLDER_VALUES = new Set([
  "change_me",
  "change-me",
  "changeme",
  "example",
  "false",
  "none",
  "null",
  "placeholder",
  "redacted",
  "true",
  "undefined",
  "xxxxxx",
  "your_password",
  "your-password",
]);

function looksLikePlaceholder(value: string): boolean {
  const first = value[0];
  if (
    first === "<" || first === "$" || first === "{" || first === "%" ||
    first === "*"
  ) {
    return true;
  }
  const lowered = value.toLowerCase();
  if (PLACEHOLDER_VALUES.has(lowered)) {
    return true;
  }
  // single repeated character, e.g. "......" or "aaaaaaaa"
  return value.length > 0 && value === first!.repeat(value.length);
}

export function shannonEntropyBitsPerChar(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

type AllowlistMatcher = (secret: string) => boolean;

function compileAllowlist(entries: string[]): AllowlistMatcher {
  if (entries.length === 0) {
    return () => false;
  }
  const literals: string[] = [];
  const regexes: RegExp[] = [];
  for (const entry of entries) {
    if (entry.length > 2 && entry.startsWith("/") && entry.endsWith("/")) {
      regexes.push(new RegExp(entry.slice(1, -1)));
    } else {
      literals.push(entry);
    }
  }
  return (secret) =>
    literals.some((literal) => secret.includes(literal)) ||
    regexes.some((regex) => regex.test(secret));
}

function redactionPlaceholder(ruleId: string): string {
  return `[REDACTED:${ruleId}]`;
}

interface SecretGroupSpan {
  start: number;
  end: number;
  secret: string;
}

function resolveSecretSpan(
  match: RegExpExecArray,
  rule: SecretsRule,
): SecretGroupSpan | undefined {
  const groupIndex = rule.secretGroup ?? 0;
  const secret = match[groupIndex];
  if (secret === undefined || secret.length === 0) {
    return undefined;
  }
  if (groupIndex === 0) {
    return {
      start: match.index,
      end: match.index + match[0].length,
      secret,
    };
  }
  const indices = match.indices?.[groupIndex];
  if (!indices) {
    return undefined;
  }
  return { start: indices[0], end: indices[1], secret };
}

/**
 * Deterministic secrets scanner/redactor for a single policy instance.
 *
 * `mode` semantics:
 * - `off`: scanning skipped entirely, content passes through.
 * - `detect`: matches reported, content unchanged.
 * - `redact`: matched secret spans replaced with `[REDACTED:<rule-id>]`.
 */
export class SecretsRedactor {
  readonly mode: SecretsPolicyMode;
  private readonly rules: SecretsRule[];
  private readonly isAllowlisted: AllowlistMatcher;
  /** Single-pass prefilter over all rule keywords (alternation, longest first). */
  private readonly combinedKeywordPattern: RegExp;
  /**
   * Longest-first alternation means a match like `sk-ant-` shadows the
   * shorter `sk-` at the same position; this maps each keyword to every
   * keyword that is a substring of it so shadowed rules still trigger.
   */
  private readonly keywordExpansions: Map<string, string[]>;

  constructor(
    policy: SecretsPolicyConfig,
    rules: SecretsRule[] = SECRETS_RULES,
  ) {
    this.mode = policy.mode;
    const disabled = new Set(policy.disabledRules);
    this.rules = rules.filter((rule) => !disabled.has(rule.id));
    this.isAllowlisted = compileAllowlist(policy.allowlist);

    const keywords = Array.from(
      new Set(this.rules.flatMap((rule) => rule.keywords)),
    ).sort((a, b) => b.length - a.length);
    const escaped = keywords.map((keyword) =>
      keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    );
    this.combinedKeywordPattern = new RegExp(escaped.join("|"), "gi");
    this.keywordExpansions = new Map(
      keywords.map((
        keyword,
      ) => [keyword, keywords.filter((other) => keyword.includes(other))]),
    );
  }

  private collectMatchedKeywords(text: string): Set<string> {
    const matched = new Set<string>();
    this.combinedKeywordPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = this.combinedKeywordPattern.exec(text)) !== null) {
      const keyword = match[0].toLowerCase();
      if (!matched.has(keyword)) {
        for (const expansion of this.keywordExpansions.get(keyword) ?? []) {
          matched.add(expansion);
        }
      }
    }
    return matched;
  }

  processText(text: string): ProcessTextResult {
    if (this.mode === "off" || text.length === 0) {
      return { text, matches: [] };
    }

    const matchedKeywords = this.collectMatchedKeywords(text);
    if (matchedKeywords.size === 0) {
      return { text, matches: [] };
    }

    const counts = new Map<string, number>();
    let current = text;

    for (const rule of this.rules) {
      if (!rule.keywords.some((keyword) => matchedKeywords.has(keyword))) {
        continue;
      }

      rule.pattern.lastIndex = 0;
      let output = "";
      let consumedTo = 0;
      let ruleMatches = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(current)) !== null) {
        if (match[0].length === 0) {
          rule.pattern.lastIndex += 1;
          continue;
        }
        const span = resolveSecretSpan(match, rule);
        if (!span) {
          continue;
        }
        if (this.isAllowlisted(span.secret)) {
          continue;
        }
        if (rule.skipPlaceholders && looksLikePlaceholder(span.secret)) {
          continue;
        }
        if (rule.requireDigitOrSymbol && !/[0-9+/=]/.test(span.secret)) {
          continue;
        }
        if (
          rule.minEntropyBitsPerChar !== undefined &&
          shannonEntropyBitsPerChar(span.secret) < rule.minEntropyBitsPerChar
        ) {
          continue;
        }
        ruleMatches += 1;
        if (this.mode === "redact") {
          output += current.slice(consumedTo, span.start) +
            redactionPlaceholder(rule.id);
          consumedTo = span.end;
        }
      }

      if (ruleMatches > 0) {
        counts.set(rule.id, (counts.get(rule.id) ?? 0) + ruleMatches);
        if (this.mode === "redact" && consumedTo > 0) {
          current = output + current.slice(consumedTo);
        }
      }
    }

    return {
      text: current,
      matches: Array.from(counts, ([ruleId, count]) => ({ ruleId, count })),
    };
  }
}

export function createSecretsRedactor(
  policy: SecretsPolicyConfig,
): SecretsRedactor {
  return new SecretsRedactor(policy);
}

function mergeMatches(
  target: Map<string, number>,
  matches: SecretsRuleMatchSummary[],
): void {
  for (const match of matches) {
    target.set(match.ruleId, (target.get(match.ruleId) ?? 0) + match.count);
  }
}

function processUnknownValue(
  value: unknown,
  redactor: SecretsRedactor,
  counts: Map<string, number>,
): unknown {
  if (typeof value === "string") {
    const result = redactor.processText(value);
    mergeMatches(counts, result.matches);
    return result.text;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => processUnknownValue(entry, redactor, counts));
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      output[key] = processUnknownValue(source[key], redactor, counts);
    }
    return output;
  }
  return value;
}

function processEventContent(
  event: ConversationEvent,
  redactor: SecretsRedactor,
): { event: ConversationEvent; matches: SecretsRuleMatchSummary[] } {
  const counts = new Map<string, number>();
  const processText = (text: string): string => {
    const result = redactor.processText(text);
    mergeMatches(counts, result.matches);
    return result.text;
  };

  let next: ConversationEvent = event;
  switch (event.kind) {
    case "message.user":
    case "message.assistant":
    case "message.system":
    case "thinking":
    case "provider.info":
      next = { ...event, content: processText(event.content) };
      break;
    case "tool.call":
      next = {
        ...event,
        ...(event.description !== undefined
          ? { description: processText(event.description) }
          : {}),
        ...(event.input !== undefined
          ? {
            input: processUnknownValue(event.input, redactor, counts) as Record<
              string,
              unknown
            >,
          }
          : {}),
      };
      break;
    case "tool.result":
      next = { ...event, result: processText(event.result) };
      break;
    case "decision":
      next = {
        ...event,
        summary: processText(event.summary),
        ...(event.metadata !== undefined
          ? {
            metadata: processUnknownValue(
              event.metadata,
              redactor,
              counts,
            ) as Record<string, unknown>,
          }
          : {}),
      };
      break;
  }

  return {
    event: next,
    matches: Array.from(counts, ([ruleId, count]) => ({ ruleId, count })),
  };
}

/**
 * Applies the secrets policy to canonical conversation events.
 *
 * Fail-closed: an event the transform throws on is dropped (reported in
 * `droppedEventIds`), never passed through unredacted.
 */
export function redactConversationEvents(
  events: ConversationEvent[],
  redactor: SecretsRedactor,
): ProcessEventsResult {
  if (redactor.mode === "off") {
    return { events, redactedEvents: [], droppedEventIds: [] };
  }

  const output: ConversationEvent[] = [];
  const redactedEvents: RedactedEventOutcome[] = [];
  const droppedEventIds: string[] = [];

  for (const event of events) {
    try {
      const { event: processed, matches } = processEventContent(
        event,
        redactor,
      );
      output.push(redactor.mode === "redact" ? processed : event);
      if (matches.length > 0) {
        redactedEvents.push({ eventId: event.eventId, matches });
      }
    } catch {
      droppedEventIds.push(event.eventId);
    }
  }

  return { events: output, redactedEvents, droppedEventIds };
}
