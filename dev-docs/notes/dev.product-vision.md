---
id: 4tvkvybigqrxc5yehscco6o
title: Product Vision
desc: ''
updated: 1771728919637
created: 1771728320207
---

**Own Your AI Conversations**

## 1. Vision

Kato is a local-first, security-bounded capture and orchestration system for AI conversations.

It gives individuals and teams durable ownership of their AI interactions by:

* Capturing conversations across tools
* Structuring them as portable, humane artifacts
* Preparing those artifacts for long-term use (analysis, publishing, memory systems, semantic modeling) and storage

Kato more than a chat logger. It is the control plane for personal AI data.

---

## 2. Problem

AI conversations today are:

* Locked inside proprietary tools
* Ephemeral and difficult to retrieve
* Store in illegible (to humans) formats
* Mixed with unrelated filesystem/network access

Users who care about their conversation data, privacy, portability, and long-term value lack:

* Control over what gets recorded, and where
* Strong containment guarantees
* Tool-agnostic capture
* A principled foundation for future AI-native workflows

Conversation data allows both humans and AIs to reference context, history, and decisions. This data is essential for refining workflows and automation.
 
If users do not own their data, they lose history and context.

---

## 3. Thesis

Kato’s core thesis:

> AI interaction should be locally contained, explicitly permitted, and structurally durable.

This implies:

1. Default-deny runtime permissions
2. Explicit filesystem scoping
3. Process-level isolation for agents
4. Deterministic capture pipelines
5. Artifact-based output, not opaque blobs

This is why a Deno-native architecture is strategically aligned.

---

## 4. Principles

### 4.1 Local-First

No required cloud service.
No required network access.
No telemetry by default.

### 4.2 Least Privilege by Construction

Agents and processes are granted:

* Access only to their assigned conversation
* Access only to their assigned output path
* No ambient filesystem authority
* No network unless explicitly enabled

### 4.3 Composability

Kato must:

* Work across Claude Code, Codex, and future tools
* Operate as CLI or daemon
* Integrate into larger systems (e.g., Semantic Flow, Stagecraft)

### 4.4 Durable Structure

Exports are:

* Deterministic
* Structured
* Versionable
* Machine-parseable
* Human-readable

### 4.5 Security Is Architectural, Not Optional

Security cannot be implemented as convention.
It must be enforced by runtime boundaries.

---

## 5. What Kato Is (and Is Not)

### Kato Is:

* A capture engine
* A local orchestration layer
* A boundary enforcer
* A structured export pipeline
* A foundation for future AI-native systems

### Kato Is Not:

* A cloud SaaS
* A chat UI
* A wrapper around one vendor
* A surveillance tool
* A marketing analytics platform

---

## 6. Target Users

### Phase 1

* Developers using local LLM tooling
* Security-conscious AI power users
* Teams wanting durable AI transcripts

### Phase 2

* Enterprises with compliance requirements
* Researchers building long-lived AI workflows
* Creators building AI-assisted knowledge systems

### Phase 3 (Long-Term Vision)

* Stagecraft runtime users (running bounded agents)
* Semantic Flow ecosystem users
* AI-native application developers

---

## 7. Architectural Direction (Deno-Native)

### 7.1 Why Deno

* Default-deny permission model
* Scoped filesystem access
* Compiled binary distribution
* Cleaner dependency model
* Future alignment with sandboxed execution environments

This is not aesthetic preference.
It is alignment with least-privilege execution as a product commitment.

### 7.2 Process Model

Each conversation or agent:

* Runs in its own constrained process
* Has scoped read/write access
* Has no implicit network access
* Cannot escalate privileges

The orchestrator:

* Has only configuration access
* Cannot read arbitrary user directories
* Cannot exfiltrate data

This allows enforceable guarantees, not just documentation claims.

---

## 8. Roadmap Shape

### Phase 1 — Secure Capture Core

* CLI export
* Background monitor
* Scoped permission enforcement
* Deterministic Markdown export
* Structured JSON export

### Phase 2 — Multi-Agent Boundaries

* Per-agent sandboxing
* Explicit capability grants
* Policy config per session
* Permission visualization

### Phase 3 — Artifact Graph

* Structured conversation objects
* Metadata indexing
* Hooks for semantic modeling
* Integration path to Semantic Flow

### Phase 4 — Safe Execution Substrate

* Sandboxed plugin model
* WASM or microVM integration
* Code execution containment
* Stagecraft alignment

---

## 9. Risks

### 9.1 Over-Engineering Early

Security posture must not block early usability.

### 9.2 Illusion of Security

Permission flags are not equivalent to full sandbox isolation.
Future arbitrary-code execution requires deeper isolation (e.g., microVMs).

### 9.3 Rewrite Fatigue

Starting over must carry forward lessons learned.
Do not lose scar tissue.

---

## 10. Success Criteria

Kato succeeds when:

* Users can verifiably restrict it to a single directory.
* A compromised dependency cannot read unrelated user data.
* Conversations are portable and tool-agnostic.
* Enterprise users can audit its permission surface.
* It becomes the default local capture substrate for AI workflows.

---

## 11. Strategic Alignment

Kato is:

* The security foundation for Stagecraft
* The capture substrate for Semantic Flow
* The boundary layer between AI agents and user data

If Stagecraft will one day execute arbitrary code,
Kato must establish the security philosophy now.

---

## 12. Positioning Statement

> Kato is the secure, local-first control layer for AI conversations.
> Install Kato. Own your AI conversations.

