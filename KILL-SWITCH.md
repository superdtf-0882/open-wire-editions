# Stopping the Open Wire, and every way its controls can be crossed

**Owner:** David Facer · **Repository:** `superdtf-0882/open-wire-editions`
**Governed by:** `AC-011` (Issued 2026-08-31), `ADR-009` (Approved, v3), `RULE-10`

This file exists because two governed obligations require it, and both are
about the same thing: **a capability nobody has written down is a capability
nobody can find.**

- **`AC-011` acceptance:** *"The kill switch is written down in the governed
  record … Declared, not built: the capability exists and what is owed is that
  a reader can find it."*
- **`RULE-10`:** *"A control is an artifact that refuses."* Anything here that
  refuses owes a statement of the paths by which it can be crossed, **or an
  assertion that none exist.**

---

## 1. Stopping publication

**Three routes, fastest first. None requires a code change.**

| | What to do | Effect | Reversible |
|---|---|---|---|
| **1. Disable the schedule** | GitHub → this repo → **Actions** → **Generate edition** → **⋯** → **Disable workflow** | No further editions are generated. The site keeps serving the last published edition indefinitely. | Yes — **Enable workflow** |
| **2. Revert the last edition** | `git revert` the last `Edition …` commit, or `git checkout HEAD~1 -- editions/ && git commit` | The previous edition becomes current. The site picks it up on its next revalidation, or immediately if revalidation is called. | Yes |
| **3. Revoke the key** | Disable `ANTHROPIC_API_KEY` in the Anthropic console | Every run fails at the first API call and publishes nothing. **Blunt** — use when the concern is spend or misuse rather than content. | Yes, by issuing a new key |

**Route 1 is the right default.** It stops the machine without touching what
readers currently see, and `AC-011`'s fail-closed design means a stopped
pipeline leaves the last good edition live with **no rollback step**.

> **Removing a single item** is not a kill switch and is not here. `REQ-LEG-7`
> requires a documented correction route; it is a content edit to
> `editions/current.json` followed by a revalidation call, not a shutdown.

**What stopping does NOT do:** it does not take `/wire` down. The page keeps
serving the last edition. To remove the page itself, that is a change to
`superdtf-0882.github.io`, not to this repository — **Shape A means this
repository cannot affect the site's routes at all.**

---

## 2. Every control in this repository, and how it can be crossed

**`RULE-10` requires this list to be complete.** A control that refuses and is
not listed here is a defect in this file, not in the control.

### 2.1 Controls that refuse, with a declared crossing

| Control | Where | Refuses when | **Declared crossing** |
|---|---|---|---|
| **Prompt-approval gate** | `generate.js` (exit 3) | `OPEN_WIRE_PROMPT_APPROVED` is not `true` | **Set the repository variable `OPEN_WIRE_PROMPT_APPROVED=true`.** This is the intended crossing and is `WP-WIRE-01` activity 5's act: it should be set **only** once David has approved `lib/prompt.js` on the record under `P-07`. **Setting it is not the approval; it records one.** |
| **Missing-key refusal** | `generate.js` (exit 2) | `ANTHROPIC_API_KEY` is absent | Run with `--fixture` or `--dry-run`, which need no key and cannot publish. |
| **Config placeholder check** | `lib/config.js` | `model.id` is still `<pin an exact model id here>` | Pin a real model id. **No bypass exists and none should.** |
| **Closing gates** | `lib/gates.js`, `generate.js` (exit 1) | any gate returns `fail` | **Three, and all three are real.** (a) Edit a threshold in `wire.config.yaml` — which is a **reviewable committed diff**, by design under `REQ-CFG-1`. (b) `--skip-network`, which skips `REQ-GATE-2` only and is marked `skipped` in the run report rather than `pass`. (c) Commit `editions/current.json` **by hand**, bypassing the job entirely — see §2.3. |
| **Heartbeat schedule check** | `.github/workflows/heartbeat.yml` | `generate.yml` is not `active`, or no edition in 48h | Disable the heartbeat workflow. **Doing so removes the only automatic notice that publication has stopped.** |

### 2.2 Controls that are WARN-LEVEL BY DESIGN — crossed on every run

**These are the two `AC-011` names as *"live crossings today and neither is
declared"*. They are declared here.**

| | |
|---|---|
| **`REQ-GATE-7` (novelty)** | Exceeding the carry-over ceiling **warns and publishes**. That is the spec's own *"Warn, publish"*, not a leak. **The crossing is permanent and structural: this gate can never block.** It is a control in the sense that it reports, and not in the sense that it refuses — and `RULE-10`'s test (*"an artifact that refuses"*) means **it is arguably not a control at all.** Recorded here because `AC-011` named it, and the honest answer to "how can it be crossed" is *"it does not need to be — it never stops anything."* |
| **`REQ-GATE-9` (cost)** | The **per-run** ceiling `maxCostUsdPerRun` **does** refuse (exit 1). The **monthly** ceiling `maxCostUsdPerMonth` **is not enforced anywhere**: `wire.config.yaml` carries `maxCostUsdPerMonth: 300.00` and `onMonthlyCapExceeded: pause`, and **no code reads either field.** **This is an undeclared control becoming a declared gap.** Monthly spend is bounded today only by the per-run ceiling times the number of runs — at $6.00 × 62 runs a month, **the effective monthly ceiling is $372, above the configured $300.** Owner: David. Enforcing it needs run-cost history the run reports now retain. |

### 2.3 The crossing no gate can see

**Anything committed directly to `editions/current.json` is served.** The site
fetches that file; it does not verify that a generate run produced it. A
hand-edited or hand-committed edition passes no gates because it encounters
none.

> **This is not a defect to fix — it is `REQ-LEG-7`'s correction route and
> route 2 above, both of which require exactly this ability.** It is recorded
> because a reader who assumes "everything published passed the gates" would
> be wrong, and `RULE-10` exists so that assumption is never load-bearing.

### 2.4 Asserted: no other control exists here

**Every refusal in this repository is listed above.** The workflows'
`concurrency` group and `timeout-minutes` bound a run but do not refuse
publication; the tests refuse a bad commit but publish nothing.

---

## 3. What is NOT yet true, as of 2026-09-01

**Stated plainly so this file is not read as describing a running system.**

- **No edition has ever been generated.** `editions/` holds no `current.json`.
- **The prompt is not approved.** `generate.js` refuses a production run.
  `WP-WIRE-01` activity 5.
- **`OPEN_WIRE_REVALIDATE_SECRET` is not set**, and the site's revalidation
  route does not exist yet. `revalidate.js` reports the call as skipped and
  **publishes anyway**, which is the required fail-soft posture.
- **`REQ-GATE-10`** (the site builds with the new edition) is **not evaluated
  here** and is reported as `deferred`. Under Shape A the site build is not
  this repository's act.
