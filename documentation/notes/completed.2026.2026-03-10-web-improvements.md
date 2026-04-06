---
id: knni6qed989b0v7qnia1fcv
title: 2026 03 10 Web Improvements
desc: ''
updated: 1773188494256
created: 1773183637761
---

## Logs pages

- choice filters should be activated "on selection", and not lose the selection
- filter activations should show as filter buttons with x's that you can click to remove
- apply button can be removed

## Add a Recordings page

## Sessions page

- Current "Session Activity" becomes "Session Ingest", only lists active or idle twin generation
- Separate "Session List" pill lists all discovered sessions, highlighting ones that are active in green and idle in yellow.
- probably have to clarify links into this page, and elsewhere (summary) differentiate between session ingest and sesions.

## Workspace Page 

- We don't need both these lines:

/home/djradon/hub/spectacular-voyage/kato/documentation/notes
/home/djradon/hub/spectacular-voyage/kato/documentation/notes/.kato-workspace-config.yaml

since there is a 1-to-1 correspondence, and the workspaceRoot is always the directory that conatins the config. I think we remove the yaml line.

- workspaces should display any workspaceUsernames from the user config
- move the "write root covered" and "config valid" text under the workspace path and above the "recordings:..." line; move the "view seesions" and "unregister" buttons up where the "config valid" text currently lives; this should allow for the recordings list to span the whole tile. 
- the recording "name" which is really the session name, should be moved up to where the recording status text currently is (e.g. idle); I don't think we need that text.
- the recordings absolute path can be shortened to just the destination dir+filename within the workspace. 
- hide the recordings list by default under a flippable chevron next to the "recordings:..." text that expands to show the recordings.

- move the "Write Root Coverage" to the bottom of the page.

### Register Workspace

- span the entire content div
- move "Workspace Path" text and input box above "Alias" and mark "Workspace Path" with a "required" red star
- split the "Register Workspace" tile into two columns and move the instructional text to the right column
- if Windows is detected, the sample /abs/path/to/workspace should be "C:\abs\path\to\workspace"

## Sessions Page

- When filtering to "Active only" remove the text that says "Idle: 3, Off: 0"
- When Filtering by workspace, the title should change from "Session Activity" to "Session Activity for <alias>" and the "Workspace: <GUID>" should be on its own line above the "Active: 1, Idle: 3, Off: 0" line
- For the recordings list per session, 
- The "recordings list" has several changes:
  - we only need the status of the latest recording per output destination. i.e., for recordings that have been stopped and then started (which in our model is actually a new recording) with the same output destination, only display for the most recent one. 
  - For the top line for each recording, instead of "<status>" (e.g. "idle"), let's dislpay the text "<workspace-alias>: " + workspace-relative path to the output file, e.g. "k: conv.2026.2026-03-07_0030-continue-the-test-refactor-work-in-task-codex-2.md".
    - we can then remove the right-aligned "workspace: k" text.
    - make the workspace-alias a link to an anchor in the Workspaces page