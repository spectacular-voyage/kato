// Form submissions for the seven POST pages, recorded from the built Fresh
// server on 2026-11-10. Each page gets at least one successful submission and
// one rejected one, plus a read-back where the effect is visible in JSON.
//
// ORDER MATTERS: the rows run top to bottom against one isolated HOME. The
// workspace is registered before the rows that select it, and a recording is
// engaged on the fixture session before the Recordings rows act on it.
import {
  DEFAULT_WORKSPACE_FILENAME_TEMPLATE,
  DEFAULT_WORKSPACE_TIMEZONE,
} from "@kato/runtime";
import { FIXTURE_SESSION_ID, FIXTURE_WORKSPACE_ALIAS } from "./harness.ts";
import {
  type Case,
  type CaseContext,
  HTML,
  JSON_TYPE,
  TEXT,
  title,
} from "./cases.ts";

const ORIGIN = "http://kato.local";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SHORT_ID = "fixture-"; // first 8 characters of FIXTURE_SESSION_ID

function rejected(body: string): Case["expect"] {
  return { status: 400, contentType: TEXT, bodyEquals: body };
}

function post(
  name: string,
  path: string,
  form: Case["form"],
  expect: Case["expect"],
  extra: Partial<Case> = {},
): Case {
  return {
    name,
    auth: "authenticated",
    method: "POST",
    path,
    form,
    expect,
    ...extra,
  };
}

function redirect(location: string): Case["expect"] {
  return { status: 303, location: `${ORIGIN}${location}` };
}

function redirectMatching(pattern: string): Case["expect"] {
  return { status: 303, locationMatches: new RegExp(`^${pattern}$`) };
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const settingsCases: Case[] = [
  post(
    "Settings: set the default username",
    "/settings",
    { action: "set-default", username: "Dave R" },
    redirect("/settings?notice=default%20username%20set%3A%20Dave%20R"),
  ),
  post(
    "Settings: a blank default username is rejected",
    "/settings",
    { action: "set-default", username: "  " },
    redirect("/settings?error=username%20must%20be%20a%20non-empty%20string"),
  ),
  post(
    "Settings: clear the default username",
    "/settings",
    { action: "clear-default" },
    redirect("/settings?notice=default%20username%20cleared"),
  ),
  post(
    "Settings: exclude me from participant lists",
    "/settings",
    { action: "set-exclude-me", excludeMeFromParticipantList: "on" },
    redirect("/settings?notice=excludeMeFromParticipantList%20set%20to%20true"),
  ),
  post(
    "Settings: save global tag suggestions",
    "/settings",
    { action: "set-global-tag-suggestions", tags: "alpha, beta\ngamma" },
    redirect("/settings?notice=global%20tag%20suggestions%20saved%20(3)"),
  ),
  post(
    "Settings: an unknown action is a bad request",
    "/settings",
    { action: "nope" },
    rejected("unsupported settings action"),
  ),
];

const maintenanceCases: Case[] = [
  post(
    "Maintenance: log truncation dry run",
    "/maintenance",
    { action: "logs-dry-run" },
    // The counts depend on which log files earlier rows created.
    redirectMatching(
      escapeRegExp(
        `${ORIGIN}/maintenance?notice=Log+truncation+dry-run%3A+clean+completed+mode%3Ddry-run+all%3Dtrue+`,
      ) + ".*" + escapeRegExp("&twinsDays=30"),
    ),
  ),
  post(
    "Maintenance: log truncation needs confirmation",
    "/maintenance",
    { action: "logs-execute" },
    redirect(
      "/maintenance?error=Explicit+confirmation+is+required+before+flushing+logs.",
    ),
  ),
  post(
    "Maintenance: twin cleanup dry run",
    "/maintenance",
    { action: "twins-dry-run", twinsDays: "30" },
    redirect(
      "/maintenance?notice=Twin+cleanup+dry-run%3A+clean+completed+mode%3Ddry-run+twins%3D30d+logsToFlush%3D0+twinsToDelete%3D0+twinFilesToDelete%3D0+missingFiles%3D0+deletionFailures%3D0&twinsDays=30",
    ),
  ),
  post(
    "Maintenance: twin cleanup rejects negative days",
    "/maintenance",
    { action: "twins-dry-run", twinsDays: "-1" },
    redirect(
      "/maintenance?error=Twin+cleanup+days+must+be+a+whole+number+greater+than+or+equal+to+0",
    ),
  ),
  post(
    "Maintenance: twin ingest of an unknown session",
    "/maintenance",
    { action: "twin-ingest", sessionId: "nope" },
    redirect("/maintenance?error=Session+not+found%3A+nope"),
  ),
  post(
    "Maintenance: an unknown action is a bad request",
    "/maintenance",
    { action: "nope" },
    rejected("unsupported maintenance action"),
  ),
];

const workspaceCases: Case[] = [
  post(
    "Workspaces: a relative path is rejected",
    "/workspaces",
    { action: "register", workspacePath: "rel/path" },
    redirect(
      "/workspaces?error=Relative%20workspace%20paths%20require%20a%20current%20working%20directory",
    ),
  ),
  post(
    "Workspaces: register the fixture workspace",
    "/workspaces",
    ({ fixtures }) => ({
      action: "register",
      workspacePath: fixtures.workspaceDir,
      alias: FIXTURE_WORKSPACE_ALIAS,
      displayName: "Fixture WS",
    }),
    redirect(
      `/workspaces?notice=workspace%20registered%3A%20${FIXTURE_WORKSPACE_ALIAS}%20(Fixture%20WS)`,
    ),
  ),
  {
    name: "Workspaces: the registered workspace is listed",
    auth: "authenticated",
    path: "/api/workspaces",
    expect: {
      status: 200,
      contentType: JSON_TYPE,
      jsonIncludes: {
        "rows.length": 1,
        "rows.0.alias": FIXTURE_WORKSPACE_ALIAS,
      },
    },
  },
  post(
    "Workspaces: save a display name",
    "/workspaces",
    {
      action: "save-display-name",
      selector: FIXTURE_WORKSPACE_ALIAS,
      displayName: "Fixture Two",
    },
    redirect(
      `/workspaces?notice=workspace%20label%20saved%3A%20${FIXTURE_WORKSPACE_ALIAS}%20(Fixture%20Two)`,
    ),
  ),
  post(
    "Workspaces: unregister an unknown workspace",
    "/workspaces",
    { action: "unregister", selector: "nope" },
    redirect("/workspaces?error=Workspace%20not%20found%3A%20nope"),
  ),
  post(
    "Workspaces: an unknown action is a bad request",
    "/workspaces",
    { action: "nope" },
    rejected("unsupported workspace action"),
  ),
  post(
    "Settings: map a username for the registered workspace",
    "/settings",
    {
      action: "set-mapping",
      selector: FIXTURE_WORKSPACE_ALIAS,
      username: "wsuser",
    },
    redirect(
      `/settings?notice=user%20mapping%20set%3A%20${FIXTURE_WORKSPACE_ALIAS}%20-%3E%20wsuser`,
    ),
  ),
];

const editPath = `/workspaces/${FIXTURE_WORKSPACE_ALIAS}/edit`;

const workspaceEditCases: Case[] = [
  {
    name: "Workspace config: the edit page renders for the alias",
    auth: "authenticated",
    path: editPath,
    expect: {
      status: 200,
      contentType: HTML,
      title: title("Workspace Config"),
      bodyIncludes: ["Wikilink Diagnostics"],
    },
  },
  post(
    "Workspace config: required fields are enforced",
    editPath,
    { action: "save-workspace-config" },
    redirect(`${editPath}?error=defaultOutputDir+is+required`),
  ),
  post(
    "Workspace config: save redirects to the workspace id",
    editPath,
    {
      action: "save-workspace-config",
      defaultOutputDir: "notes",
      filenameTemplate: DEFAULT_WORKSPACE_FILENAME_TEMPLATE,
      workspaceTimezone: DEFAULT_WORKSPACE_TIMEZONE,
    },
    redirectMatching(
      escapeRegExp(`${ORIGIN}/workspaces/`) + UUID +
        escapeRegExp(
          `/edit?notice=workspace+config+saved%3A+${FIXTURE_WORKSPACE_ALIAS}`,
        ),
    ),
  ),
  post(
    "Workspace config: an unknown action is a bad request",
    editPath,
    { action: "nope" },
    rejected("unsupported workspace config action"),
  ),
];

const sessionHash = `#session-${FIXTURE_SESSION_ID}`;

const sessionCases: Case[] = [
  post(
    "Sessions: a blank session id is rejected",
    "/sessions",
    { action: "update-session-metadata-defaults" },
    redirect("/sessions?error=Session+id+is+required"),
  ),
  post(
    "Sessions: update session metadata defaults",
    "/sessions",
    {
      action: "update-session-metadata-defaults",
      sessionId: FIXTURE_SESSION_ID,
      displayTitle: "Fixture Title",
      tags: "one,two",
    },
    redirect(
      `/sessions?notice=session+metadata+updated+%28${SHORT_ID}%29${sessionHash}`,
    ),
  ),
  post(
    "Sessions: a new recording needs a workspace selector",
    "/sessions",
    { action: "new-recording", sessionId: FIXTURE_SESSION_ID },
    redirect("/sessions?error=Workspace+selector+is+required"),
  ),
  post(
    "Sessions: engage a new recording",
    "/sessions",
    {
      action: "new-recording",
      sessionId: FIXTURE_SESSION_ID,
      workspaceSelector: FIXTURE_WORKSPACE_ALIAS,
      displayTitle: "Fixture Rec",
      filenameSlug: "fixture-rec",
    },
    redirect(
      `/sessions?notice=recording+engaged%3A+${FIXTURE_WORKSPACE_ALIAS}+%28${SHORT_ID}%29${sessionHash}`,
    ),
  ),
  post(
    "Sessions: an unknown action is a bad request",
    "/sessions",
    { action: "nope", sessionId: FIXTURE_SESSION_ID },
    rejected("unsupported sessions action"),
  ),
  {
    name: "Sessions: the engaged recording is listed",
    auth: "authenticated",
    path: "/api/recordings",
    expect: {
      status: 200,
      contentType: JSON_TYPE,
      jsonIncludes: {
        activeRecordingCount: 1,
        "rows.0.sessionId": FIXTURE_SESSION_ID,
      },
    },
  },
  {
    name: "Sessions: the session detail page renders for a known id",
    auth: "authenticated",
    path: `/sessions/${FIXTURE_SESSION_ID}`,
    expect: {
      status: 200,
      contentType: HTML,
      title: title(`Session ${SHORT_ID}`),
    },
  },
];

const recordingHash = `#recording-${UUID}`;
const recordingSelector = (context: CaseContext) => context.firstRecording();

const recordingCases: Case[] = [
  post(
    "Recordings: a blank session id is rejected",
    "/recordings",
    { action: "stop-recording" },
    redirect("/recordings?error=invalid_request#recordings"),
  ),
  post(
    "Recordings: the CSRF token must be in the form body",
    "/recordings",
    { action: "stop-recording", sessionId: FIXTURE_SESSION_ID },
    { status: 403, contentType: TEXT, bodyEquals: "csrf token required" },
    { csrf: "header" },
  ),
  post(
    "Recordings: update recording tags",
    "/recordings",
    async (context) => ({
      action: "update-recording-metadata",
      ...(await recordingSelector(context)),
      tags: "x,y",
    }),
    redirectMatching(
      escapeRegExp(
        `${ORIGIN}/recordings?notice=recording+tags+updated+%28${SHORT_ID}%29`,
      ) + recordingHash,
    ),
  ),
  post(
    "Recordings: set writer overrides",
    "/recordings",
    async (context) => ({
      action: "set-writer-overrides",
      ...(await recordingSelector(context)),
      commentary: "exclude",
      thinking: "include",
    }),
    redirectMatching(
      escapeRegExp(
        `${ORIGIN}/recordings?notice=render+policy+updated%3A+commentary+exclude%2C+thinking+include+%28${SHORT_ID}%29`,
      ) + recordingHash,
    ),
  ),
  post(
    "Recordings: stop the recording",
    "/recordings",
    async (context) => ({
      action: "stop-recording",
      ...(await recordingSelector(context)),
    }),
    redirectMatching(
      escapeRegExp(
        `${ORIGIN}/recordings?notice=recording+stopped%3A+${FIXTURE_WORKSPACE_ALIAS}+%28${SHORT_ID}%29`,
      ) + recordingHash,
    ),
  ),
  post(
    "Recordings: an unknown action is a bad request",
    "/recordings",
    { action: "nope", sessionId: FIXTURE_SESSION_ID },
    rejected("unsupported recordings action"),
  ),
  {
    name: "Recordings: the stopped recording is counted",
    auth: "authenticated",
    path: "/api/recordings",
    expect: {
      status: 200,
      contentType: JSON_TYPE,
      jsonIncludes: { activeRecordingCount: 0, stoppedRecordingCount: 1 },
    },
  },
];

export const MUTATION_CASES: Case[] = [
  ...settingsCases,
  ...maintenanceCases,
  ...workspaceCases,
  ...workspaceEditCases,
  ...sessionCases,
  ...recordingCases,
];
