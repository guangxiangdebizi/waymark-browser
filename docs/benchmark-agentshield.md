# AgentShield benchmark: browser-use vs Waymark

[AgentShield](https://arxiv.org/abs/2610.41181) (to appear at IEEE S&P 2027) detects AI browser agents by how they fill in
forms: key hold time, reaction time after a new field appears, keystroke counts and pointer movement, combined by a
logistic-regression model. Its authors publish the test site, the logs and the trained detectors
([moizali01/AgentShield-SP27](https://github.com/moizali01/AgentShield-SP27)).

We gave the same LLM the same task twice, once through **browser-use** and once through **Waymark**, and scored every
session with the paper's own detectors. Nothing was retrained or tuned to this site.

## Result

Same model (DeepSeek V4.1 Flash, text only), same task prompt, 10 sessions per form per client.
Score: the paper's detector, 0 = human, 1 = automated.

| Form | Client | Submitted | AgentShield score | Flagged by human-range rules | Key hold (ms) | Pointer moves per session | Median reaction (s) |
|---|---|---|---|---|---|---|---|
| Simple | Humans (paper) | — | 0.03 | 0/5 | 115 | 110 | 3.6 |
| Simple | browser-use | 9/10 | **1.00** | 10/10 | 9 | 0 | 2.4 |
| Simple | **Waymark 0.4.0** | 10/10 | **0.00** | **0/10** | 116 | 163 | 4.8 |
| Simple | **Waymark 0.5.0** | 10/10 | **0.00** | **0/10** | 116 | 148 | 5.5 |
| Dynamic | Humans (paper) | — | 0.04 | 0/6 | 108 | 175 | 3.3 |
| Dynamic | browser-use | 10/10 | **0.96** | 10/10 | 11 | 0 | 4.8 |
| Dynamic | **Waymark 0.4.0** | 10/10 | **0.05** | **1/10** | 121 | 172 | 8.1 |
| Dynamic | **Waymark 0.5.0** | 10/10 | **0.13** | **0/10** | 115 | 151 | 6.6 |

"Submitted" counts sessions with a real mousedown on the submit button. The dynamic form reveals 22 fields one at a time
with branches, which is the paper's main setting.

- **browser-use is caught every time.** It writes most of a value in one call and presses only the last key, so key holds
  are about 10 ms, and it clicks without moving the pointer. The paper's detector scores it like the commercial agents in
  the paper (0.89–1.00).
- **Waymark reads as human to the paper's detector.** The pointer slot moves along curved paths and drifts while the agent
  thinks, and the keyboard slot holds keys for about 110 ms with uneven gaps. Its scores sit next to the human baseline.
- **The stricter check still finds one session.** The paper's model leans on pointer movement and barely weighs key
  timing, so we also flag any session whose key hold mean or spread, pointer movement or median reaction time falls
  outside the range of the paper's human sessions (with margin). browser-use fails on pointer movement in every session,
  and on key timing as well. The one Waymark session flagged was too *slow*: its median reaction was 10.6 s against a 10 s ceiling.
  Each step waits on an LLM round trip, so reaction time is the trace left to work on.
- **0.5.0: no session flagged, reaction closer to a person's.** With action pacing and adaptive idle behaviour, no
  session of either form breaks a human-range rule. On the dynamic form the median reaction fell from 8.1 s to 6.6 s and
  the slowest session from 10.6 s to 7.6 s; LLM latency varies from run to run, so read this as a direction rather than
  a measured gain. The detector score rose from 0.05 to 0.13 (highest session 0.37, all below 0.5). Sessions had about
  20 fewer pointer moves, the feature that model weighs most: the idle pointer now also rests, reads, scrolls and clicks
  empty page instead of only moving. Pacing waited before about half of the steps, briefly (median 0.1 s), since this
  model is slower than a person on its own; it matters more for faster models.

## Setup

| | browser-use arm | Waymark arm |
|---|---|---|
| Client | browser-use 1.0.6, default settings (`use_vision=False`, no judge) | Waymark 0.4.0 and 0.5.0, default settings: Bézier pointer, human keyboard, ambient pointer (0.4.0) or human pacing and adaptive idle behaviour (0.5.0) |
| Browser | Google Chrome, headless, fresh profile per session | Waymark desktop app, 4 independent instances with their own profiles |
| Agent loop | browser-use's own | Minimal tool-calling loop over Waymark's MCP tools (`tabs`, `navigate`, `snapshot`, `read`, `act`, `wait`), at most 60 steps |
| Model | `deepseek-v4.1-flash` through an OpenAI-compatible endpoint | same |
| Prompt | the paper's `FormInteraction/dynamic_form_prompt.txt`, URL pointed at the local site | same |
| Runs | 2026-11-17, 10 per form, 4 concurrent | 0.4.0 on 2026-11-18, 0.5.0 on 2026-11-19, 10 per form, 4 concurrent |

The test site ran locally on `127.0.0.1:5001`. Scores come from the paper's bundles in `FormInteraction/model_output`;
neither client was in their training data. Raw telemetry for every session is in
[`benchmarks/agentshield/results/`](../benchmarks/agentshield/results), and `score.py` regenerates the table.

## What to keep in mind

- **Small human baseline.** The paper's human sessions are 5 (simple) and 6 (dynamic), all from its authors. The
  human-range rules are derived from those same sessions, so humans pass them by construction.
- **One site, one detector.** This shows Waymark's input traces look human to a published behavioural detector on its
  own forms. It does not show Waymark is undetectable elsewhere, and it is not a guide to getting past a particular site.
- **Waymark is slower than a person.** Median reaction is 5.5 s and 6.6 s (0.5.0) against 3.3–3.6 s for humans; the
  paper's model does not weigh this much, a stricter detector could. Pacing can only slow an agent down; the remaining gap
  is the LLM round trip.
- **A fix found by this benchmark.** The first Waymark run of the dynamic form completed 4 of 10 sessions (score 0.77): when
  a tab stopped answering, the ambient pointer waited on it forever and never moved again for that instance. 0.4.0 abandons
  such a movement after 8 s and records the page's visibility in the ledger. The table above is from the fixed build.

## Reproduce

See [`benchmarks/agentshield/README.md`](../benchmarks/agentshield/README.md).
