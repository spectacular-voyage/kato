import { assertEquals } from "@std/assert";
import {
  compareDiscoveredSessionCandidates,
  dedupeDiscoveredSessions,
  type SessionDiscoveryCandidate,
} from "../apps/daemon/src/orchestrator/provider_session_discovery.ts";

function makeCandidate(
  overrides:
    & Partial<SessionDiscoveryCandidate>
    & Pick<
      SessionDiscoveryCandidate,
      "sessionId" | "filePath"
    >,
): SessionDiscoveryCandidate {
  return {
    modifiedAtMs: 0,
    ...overrides,
  };
}

Deno.test(
  "compareDiscoveredSessionCandidates prefers newer contentUpdatedAtMs over newer mtime",
  () => {
    const newerContent = makeCandidate({
      sessionId: "gemini-session",
      filePath: "/slug/session.json",
      contentUpdatedAtMs: 200,
      modifiedAtMs: 100,
      layoutType: "slug",
    });
    const newerMtime = makeCandidate({
      sessionId: "gemini-session",
      filePath: "/hash/session.json",
      contentUpdatedAtMs: 100,
      modifiedAtMs: 500,
      layoutType: "hash",
    });

    assertEquals(
      compareDiscoveredSessionCandidates(newerContent, newerMtime) < 0,
      true,
    );
    assertEquals(
      compareDiscoveredSessionCandidates(newerMtime, newerContent) > 0,
      true,
    );
  },
);

Deno.test(
  "compareDiscoveredSessionCandidates prefers slug layout over hash layout when content timestamps tie",
  () => {
    const slugCandidate = makeCandidate({
      sessionId: "gemini-session",
      filePath: "/slug/session.json",
      contentUpdatedAtMs: 200,
      modifiedAtMs: 100,
      layoutType: "slug",
    });
    const hashCandidate = makeCandidate({
      sessionId: "gemini-session",
      filePath: "/hash/session.json",
      contentUpdatedAtMs: 200,
      modifiedAtMs: 500,
      layoutType: "hash",
    });

    assertEquals(
      compareDiscoveredSessionCandidates(slugCandidate, hashCandidate) < 0,
      true,
    );
  },
);

Deno.test(
  "compareDiscoveredSessionCandidates falls back to mtime then file path",
  () => {
    const newerMtime = makeCandidate({
      sessionId: "shared",
      filePath: "/b/session.json",
      modifiedAtMs: 20,
    });
    const olderMtime = makeCandidate({
      sessionId: "shared",
      filePath: "/a/session.json",
      modifiedAtMs: 10,
    });
    const lexicallyFirst = makeCandidate({
      sessionId: "shared",
      filePath: "/a/session.json",
      modifiedAtMs: 20,
    });

    assertEquals(
      compareDiscoveredSessionCandidates(newerMtime, olderMtime) < 0,
      true,
    );
    assertEquals(
      compareDiscoveredSessionCandidates(lexicallyFirst, newerMtime) < 0,
      true,
    );
  },
);

Deno.test(
  "dedupeDiscoveredSessions keeps the best candidate per sessionId and reports duplicate ids",
  () => {
    const result = dedupeDiscoveredSessions([
      makeCandidate({
        sessionId: "beta",
        filePath: "/beta/older.json",
        modifiedAtMs: 10,
      }),
      makeCandidate({
        sessionId: "alpha",
        filePath: "/alpha/hash.json",
        modifiedAtMs: 90,
        contentUpdatedAtMs: 100,
        layoutType: "hash",
      }),
      makeCandidate({
        sessionId: "alpha",
        filePath: "/alpha/slug.json",
        modifiedAtMs: 80,
        contentUpdatedAtMs: 100,
        layoutType: "slug",
      }),
      makeCandidate({
        sessionId: "beta",
        filePath: "/beta/newer.json",
        modifiedAtMs: 20,
      }),
    ]);

    assertEquals(result.droppedEvents, 2);
    assertEquals(result.duplicateSessionIds, ["alpha", "beta"]);
    assertEquals(
      result.sessions.map((session) => [session.sessionId, session.filePath]),
      [
        ["alpha", "/alpha/slug.json"],
        ["beta", "/beta/newer.json"],
      ],
    );
  },
);
