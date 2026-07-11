import type {
  MarkdownFrontmatterConfig,
  SessionWorkspaceAttachmentWriterFeatureFlagsV1,
} from "@kato/shared";

export const WORKSPACE_MARKDOWN_FRONTMATTER_EDIT_FIELDS: Array<{
  key: keyof MarkdownFrontmatterConfig;
  name: string;
  label: string;
}> = [
  {
    key: "includeFrontmatterInMarkdownRecordings",
    name: "markdownFrontmatter.includeFrontmatterInMarkdownRecordings",
    label: "Include frontmatter",
  },
  {
    key: "includeUpdatedInFrontmatter",
    name: "markdownFrontmatter.includeUpdatedInFrontmatter",
    label: "Updated timestamp",
  },
  {
    key: "addParticipantUsernameToFrontmatter",
    name: "markdownFrontmatter.addParticipantUsernameToFrontmatter",
    label: "Participant username field",
  },
  {
    key: "addParticipantUsernameToHeadings",
    name: "markdownFrontmatter.addParticipantUsernameToHeadings",
    label: "Participant username headings",
  },
  {
    key: "includeSessionIds",
    name: "markdownFrontmatter.includeSessionIds",
    label: "Session ids",
  },
  {
    key: "includeWorkspaceIds",
    name: "markdownFrontmatter.includeWorkspaceIds",
    label: "Workspace ids",
  },
  {
    key: "includeRecordingIds",
    name: "markdownFrontmatter.includeRecordingIds",
    label: "Recording ids",
  },
  {
    key: "includeConversationEventKinds",
    name: "markdownFrontmatter.includeConversationEventKinds",
    label: "Event kinds",
  },
];

export const WORKSPACE_WRITER_FEATURE_FLAG_EDIT_FIELDS: Array<{
  key: keyof SessionWorkspaceAttachmentWriterFeatureFlagsV1;
  name: string;
  label: string;
}> = [
  {
    key: "writerIncludeCommentary",
    name: "workspaceFeatureFlags.writerIncludeCommentary",
    label: "Commentary",
  },
  {
    key: "writerIncludeThinking",
    name: "workspaceFeatureFlags.writerIncludeThinking",
    label: "Thinking",
  },
  {
    key: "writerIncludeToolCalls",
    name: "workspaceFeatureFlags.writerIncludeToolCalls",
    label: "Tool calls",
  },
  {
    key: "writerIncludeToolResults",
    name: "workspaceFeatureFlags.writerIncludeToolResults",
    label: "Tool results",
  },
  {
    key: "writerIncludeDecisionPrompt",
    name: "workspaceFeatureFlags.writerIncludeDecisionPrompt",
    label: "Decision prompt",
  },
  {
    key: "writerIncludeDecisionOptions",
    name: "workspaceFeatureFlags.writerIncludeDecisionOptions",
    label: "Decision options",
  },
  {
    key: "writerIncludeDecisionSelection",
    name: "workspaceFeatureFlags.writerIncludeDecisionSelection",
    label: "Decision selection",
  },
  {
    key: "writerItalicizeUserMessages",
    name: "workspaceFeatureFlags.writerItalicizeUserMessages",
    label: "Italicize user messages",
  },
  {
    key: "writerRelativizeLocalLinks",
    name: "workspaceFeatureFlags.writerRelativizeLocalLinks",
    label: "Relative local links",
  },
  {
    key: "writerUseDendronStyleWikilinks",
    name: "workspaceFeatureFlags.writerUseDendronStyleWikilinks",
    label: "Dendron wikilinks",
  },
];
