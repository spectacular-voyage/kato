---
id: can-you-estimate-the-tot-c3cab142
title: 'Can you estimate the total amount of time me as a novice pr…'
desc: ''
created: 1775506418846
updated: 1775506418846
participants: [djradon, codex.gpt-5.4]
kato-sessionIds: [019d568e-8b88-7cc2-98cc-612a5d6602ef]
kato-workspaceIds: [cd940f00-5558-40dc-bead-46f904ab937b]
kato-recordingIds: [c3cab142-6deb-42c6-b089-879c5165b0ac]
conversationEventKinds: [message.assistant, message.user, tool.call, tool.result]
---

# djradon_2026-04-03_2038_28

Can you estimate the total amount of time me as a novice product manager, ontologist, and and would-be architect, and you as a high-value, extremely knowledgable, incredibly versatile developer, and you as a junior programmer would have spent on the kato codebase, assuming we came straight to the current solution without any significant missteps.

# gpt-5.4_2026-04-03_2038_45

I’m going to size the current codebase and read the repo’s developer guidance first, then I’ll turn that into a clean person-hour estimate split by role.

I have the repo shape now: Deno monorepo with CLI, daemon, web, cloud, packaging scripts, and a large test suite. Next I’m reading the repo guidance and pulling size signals so the estimate isn’t hand-wavy.

The first pass overcounted because it picked up vendored or generated material under `apps/web`. I’m switching to tracked files only so the estimate reflects authored code, not artifacts.

The repository history gives a useful ceiling: roughly six weeks of steady work and 284 non-merge commits from February 21, 2026 to April 3, 2026. I’m pulling one more layer of structure now: authored LOC by subsystem and the architecture overview, so I can separate “current-solution effort” from “calendar elapsed time.”

# djradon_2026-04-03_2039_27

I mean in the pre-modern-LLM days, say 2022.

# gpt-5.4_2026-04-03_2039_42

You clarified the baseline: same end state, but estimated with 2022-era human-only productivity. I already have the repo shape; I’m just tightening the source/test split so the estimate lands on credible person-months rather than vague “a lot.”

The code volume is clearer now: about `40.9k` authored TS/TSX/JS lines outside tests and `39.0k` top-level test lines across `99` test files, plus web-internal tests. I’m checking CI/release surface once, because cross-platform packaging and quality gates materially change the 2022 estimate.

Using a 2022 human-only baseline, I’d treat Kato as roughly a `6 to 10 person-month` codebase with a strong senior generalist, or `12 to 18 person-months` with a junior-led implementation.

That estimate is based on the current scope, not just elapsed calendar time: about `40.9k` authored TS/TSX/JS lines, about `39.0k` top-level test lines, `99` top-level test files, a CLI, daemon, runtime library, web app, provider parsers, file-based IPC, persistent session-twin state, local auth, packaging scripts, and cross-platform CI/release automation.

I’m reading your question as two comparison cases:

- `You + senior developer`: you `120-220` hours, senior dev `900-1,300` hours. Total `1,020-1,520` hours.
- `You + junior programmer`: you `160-280` hours, junior dev `1,700-2,500` hours. Total `1,860-2,780` hours.

In calendar terms:

- Senior case: about `4-7` months if the engineer is near full-time and you stay engaged.
- Junior case: about `9-15` months.

The actual repository history from `February 21, 2026` to `April 3, 2026` looks more like a compressed delivery window than a good 2022 proxy. If you mean literal 2022-era tooling maturity, not just “no modern LLMs,” I’d add another `15-25%`, because the expensive parts here are the daemon/runtime architecture, parser edge cases, test harnesses, and release packaging.

# djradon_2026-04-03_2054_16

I actually meant the 3 of us working seamlessly together.

And so how much at even "huge bargain" rates, say $100/hr for senior resources, $50/hr for junior. All 3 scenarios.

# gpt-5.4_2026-04-03_2055_19

On a 2022, no-LLM, straight-shot build to the current Kato scope, I’d price the three scenarios like this.

| Scenario | Your hours | Senior hours | Junior hours | Total person-hours | External cost | Likely elapsed time |
|---|---:|---:|---:|---:|---:|---:|
| You + senior | 120-220 | 900-1,300 | 0 | 1,020-1,520 | $90k-$130k | 4-7 months |
| You + junior | 160-280 | 0 | 1,700-2,500 | 1,860-2,780 | $85k-$125k | 9-15 months |
| You + senior + junior | 130-200 | 650-950 | 500-800 | 1,280-1,950 | $90k-$135k | 3-5 months |

I’m excluding your hours from the dollar totals, since you only gave rates for senior and junior resources. If you want to assign a cash-equivalent value to your own time, just add `your hours × your rate`.

The main takeaway is that the cash cost is surprisingly similar across all three. The difference is mostly schedule and execution risk:
- `You + senior` is probably the cleanest and best-value path.
- `You + junior` is not much cheaper in total, because the extra hours eat the rate discount.
- `You + senior + junior` is the fastest, but not the cheapest; its value is calendar compression.

Best single-number guess for the three-person case: about `160` of your hours, `800` senior hours, `650` junior hours, and about `$112.5k` in external spend.
