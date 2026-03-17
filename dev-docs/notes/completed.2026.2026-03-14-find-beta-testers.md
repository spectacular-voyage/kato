---
id: edfvpbah723560du5c9wcff
title: 2026 03 14 Find Beta Testers
desc: ''
updated: 1773505613828
created: 1773499836343
---

## Goal

Draft an `r/alphaandbetausers` post to recruit early Kato beta testers.

## Summary

- Lead with the real workflow pain instead of product marketing.
- Keep the ask specific: developers who actively use AI coding tools and will
  give practical feedback.
- Position Kato as a local-first, vendor-agnostic way to preserve AI chat
  history in files you control.

## Discussion

Audience:
- Developers using `Codex`, `Claude Code`, or `Gemini` in supported IDE / CLI /
  local-app workflows.
- People who reuse old chat context for ongoing software engineering work.
- People frustrated by copy/paste transcripts, lost context, and weak search.

Pain points to highlight:
- Needing access to old chats both to jog memory and to hand back to LLMs as
  context.
- Manually copying chats out of web UIs and VS Code extensions into files.
- Forgetting to update the manual transcript after continuing a conversation.
- Losing markdown fidelity when copying whole chats.
- Not remembering which model or interface was used.
- No easy global find across past chats.

How Kato solves it:
- Captures supported chats into standardized files you control.
- Lets you move between LLMs without losing your history format.
- Keeps recording after the initial capture instead of relying on manual
  transcript patching.
- Preserves much more structure than copy/paste workflows.
- Makes chats easier to grep, reference, and feed back into assistants later.
- Supports in-chat start / stop commands so capture can be controlled from the
  conversation itself.
- Can target different destination workspaces, with customizable preferences
  and filename templating.
- Includes web and CLI consoles for monitoring and maintenance.

Beta ask:
- Looking for people who already use AI coding assistants heavily.
- Feedback areas: install/setup friction, capture reliability, transcript
  usefulness, and missing integrations.

## Draft Post

### Title Option 1

Looking for beta testers: local-first tool to save AI coding chats into files
you control

### Title Option 2

Looking for beta testers for Kato - preserve and reuse AI coding chat history
across tools

### Draft Body

I am looking for a few beta testers for Kato, a local-first tool that captures
AI coding chats into files you control.

I built it because I kept needing access to old chats about my software
engineering projects, both to jog my memory and to feed that context back into
LLM assistants later. I wanted to be able to move between LLMs while still
having a standardized way to preserve and reference chat history.

Before this, I was manually copying conversations out of web interfaces and VS
Code extensions into files I created by hand. That kept breaking down:

- I would paste a full chat once, then continue the conversation later and
  forget to patch my manual transcript.
- Copying and pasting whole chats often dropped or mangled markdown, but
  copying one turn at a time was tedious.
- I would lose track of which LLM and which interface I had used.
- I had no easy way to search across all of my past chats.

Kato solves that by capturing supported chats into a standardized format on
disk, so I can keep a portable history across tools and point other assistants
at it later. It is built for people who want their AI conversation history in
files they control instead of trapped in separate app silos.

A few workflow details that have been especially useful for me:

- I can start or stop recordings from inside the chat itself.
- I can send different conversations to different destination workspaces, with
  customizable preferences and filename templating.
- There are web and CLI consoles for monitoring and maintenance.

Today Kato supports `Codex`, `Claude Code`, and `Gemini` in supported VS Code,
CLI, and local-app setups.

I am looking for testers who already use AI coding tools heavily and are
willing to give practical feedback on:

- install and setup friction
- capture reliability
- transcript format and usefulness
- missing integrations or workflows

Comment or DM with questions or feedback.

## Personal LinkedIn Post

LinkedIn angle:
- More personal and founder-voice than Reddit.
- Shorter paragraphs, fewer bullets, and a clearer ask.
- Good for warm-network distribution, credibility, and referrals to potential
  testers.

### Draft Body

I built a small tool for a problem I kept running into while using AI for
software engineering work, and I am looking for a few beta testers.

The problem was not generating answers. It was preserving useful chat history.

I kept wanting to go back to old chats to jog my memory, recover decisions, or
feed project context into another LLM later. But my workflow was messy: I was
copying conversations out of web apps and VS Code extensions into files by
hand.

That broke down pretty quickly:

- I would save a chat once, then continue it later and forget to update the
  transcript.
- Copy/paste often dropped or mangled markdown.
- I would forget which model or interface I had used.
- I had no good way to search or reuse all of that history across tools.

So I built Kato.

Kato is a local-first tool that captures supported AI coding chats into files
you control, in a standardized format that is easier to preserve, search, and
reuse later. The goal is to make it easier to move between tools without losing
your working history in the process.

A few parts that have been especially useful for me:

- in-chat start/stop recording
- routing different chats to different destination workspaces
- customizable preferences and filename templating
- web and CLI consoles for monitoring and maintenance

Today it supports `Codex`, `Claude Code`, and `Gemini` in supported VS Code,
CLI, and local-app setups.

I am looking for a few testers who already use AI coding tools heavily and are
willing to give practical feedback on setup, capture reliability, transcript
usefulness, and missing integrations.

If that sounds like you, comment here or send me a DM and I will share details.

### Shorter LinkedIn Version

Looking for beta testers: Kato is a local-first tool to save AI chats into your personal or team workspaces.


https://github.com/spectacular-voyage/kato


I built Kato because I kept losing useful AI coding chat history across

different tools.


I wanted a standard, local-first way to preserve chats I could revisit later to

jog my memory, recover decisions, share with the team, or feed back into another assistant as

context.


Before this, I was manually copying conversations out of web apps and editor

extensions into files. That was tedious, hard to maintain, and dropped formatting along the way.


Kato captures local AI chats into files you control, with support

for in-chat recording commands, multiple destination workspaces, and web/CLI

monitoring tools.


It currently works with `Codex`, `Claude Code`, and `Gemini` in supported VS

Code, CLI, and local-app setups.


I am looking for a few beta testers who use AI coding tools heavily and are

willing to share feedback. Comment or DM me if it sounds useful!





## Open Issues

- Decide whether to include install-target details (`macOS`, `Windows x64`,
  `Linux x64 glibc`) in the Reddit post or save that for follow-up replies.
- Decide whether to link directly to `npm`, GitHub, or a short project landing
  page in the first post.
- Decide whether the LinkedIn post should link directly to the company page,
  product page, GitHub, or a simpler beta signup destination.

## Decisions

- `r/alphaandbetausers` draft should be pain-point-first, not feature-list
  first.
- The post should ask for practical testers, not generic upvotes or launch
  attention.
- Brief feature mentions are helpful after the pain points, especially when
  they explain how Kato fits into real workflows.
- Avoid claiming built-in search; the honest value is standardized local files
  that are easier to search and reuse.

## Contract Changes

None.

## Testing

Not applicable for this note.

## Non-Goals

- Writing launch copy for broad startup or SaaS subreddits.
- Turning the post into a full feature announcement.
- Overexplaining implementation details of how Kato captures chats.

## Implementation Plan

- [x] Capture the core user pain points behind Kato.
- [x] Draft an initial `r/alphaandbetausers` post.
- [x] Add a personal LinkedIn version.
- [ ] Tighten the CTA once the preferred beta signup path is decided.
