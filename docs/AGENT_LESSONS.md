# AGENT_LESSONS — FOS project-specific lessons

Read at session start. Project-specific gotchas and repo-workflow lessons for the Founder Operating System repo.
Format: `P-XXX` — one line title, then **Symptom → Cause → Rule**, then a **Provenance** line (which cycle / what evidence).
Cross-project process lessons (general git/validation discipline) live in `~/tasks/lessons.md`, not here.

---

## P-001 · Marking a maker PR "ready" ≠ the PR page says ready — edit the body's status line in the same step

**Symptom:** After the adversarial verifier gate passed on PR #57 (P1.3a) and I marked it ready (`gh pr ready` → `isDraft:false`, `MERGEABLE`) and added a fix-round comment, the founder opened the PR and saw it "still waiting for adversarial verification." The work was genuinely verified and ready; the page said otherwise.

**Cause:** Cloud makers (RemoteTrigger) open their PR with a body whose opening line reads `**DRAFT — do not merge; awaiting adversarial verification.**`. `gh pr ready` only flips the draft _flag_; adding a comment appends _below_ the body. Neither touches the author-controlled body text, which GitHub renders at the top of the page. So the stale "awaiting verification" line kept contradicting the real PR state — the body and the state had diverged, and the reader trusts the body.

**Rule:** When a maker PR clears its verifier gate, in the **same step** that marks it ready, rewrite the body's status line to the verified-ready state via `gh pr edit --body-file` (e.g. "✅ VERIFIED — ready for merge; base passed N-verifier gate, fix commit passed re-verify"). Do not rely on the draft flag + a comment. Treat the body's top line as a status field that must match the PR state, and verify it after editing (`gh pr view --json body,isDraft`). Corollary: a `gh pr checks` still showing `QUEUED/pending` is CI runner latency, not a failure — report it as pending, don't conflate it with the body-staleness issue.

**Provenance:** P1.3a / PR #57, 2026-07-20. Founder correction ("57 says it's still waiting for adversarial verification") after I marked #57 ready without editing the maker's stale body line. Verified via raw GitHub API (`gh api …/pulls/57`, `…/issues/58`) that state was ready and objects existed; root cause was the un-edited body, fixed by rewriting the opening line.

---

## P-002 · Run `npm run lint` before pushing any locally-authored commit — cloud makers format, you don't

**Symptom:** PR #59 (docs-only, this very `AGENT_LESSONS.md`) failed the CI `node` job at step `npm run lint` because the hand-written markdown didn't match Prettier style (`*flag*` vs `_flag_`). `typecheck` and `test` were reported as skipped — they run _after_ lint and never got the chance.

**Cause:** Commits authored locally (directly, not via a RemoteTrigger cloud maker) bypass the formatting pass the cloud makers run in their verify loop. Root `npm run lint` is `prettier --check .` over ALL files including markdown/JSON/config; any deviation fails the node job at the lint step, which gates typecheck and test.

**Rule:** Before pushing any commit I authored locally, run `npm run lint` (or `npm run format` to auto-fix) and confirm clean — especially for docs/markdown/config, where it's easy to forget Prettier governs them too. Do not assume "it's just a markdown file" is lint-exempt. The cloud makers already do this; the gap is only on my own hand-authored commits.

**Provenance:** PR #59, 2026-07-20. CI `node` step-6 (`prettier --check`) failure on `docs/AGENT_LESSONS.md`; fixed with `prettier --write` (only change was `*emphasis*` → `_emphasis_`).

---

## P-003 · Monitor/check-in loops must be read-and-report only — never granted write/Task/merge authority

**Symptom:** PR #62 appeared unbidden — a real #52 follow-up, but opened against main from _before_ #66 merged, 10 commits stale, colliding hard with the just-merged #66 (a duplicate `FOS1-RT-18` test at the same line, plus overlapping `pipeline.ts` catch-block edits). It had never been through the adversarial gate. This was the **second** parallel-session collision in the project.

**Cause:** a `send_later` "watch PR #61" check-in loop was configured with the full write toolset (`Edit`/`Write`/`MultiEdit`/`Task`) and an "address anything actionable" mandate, re-arming hourly. With nothing actionable on #61, a firing of that loop grabbed issue #52 off the backlog and opened a PR against stale `main` — unsupervised, ungated, on a base that a concurrent interactive slice (#66) was about to invalidate. A loop meant to _observe_ instead _produced_ work.

**Rule:** a loop whose job is to _watch/report_ on a PR gets read-and-report tools ONLY — no `Edit`/`Write`/`MultiEdit`/`Task`, no branch/PR creation, no merge. Any actual code work goes through an explicit, supervised maker dispatch on a known-fresh base (`run_once`, scoped `allowed_tools`), never a watcher's latitude to "fix anything." When creating check-in routines, scope `allowed_tools` to read/report (`Read`/`Grep`/`Glob`/`Bash` read-only + the PR-read MCP) and never leave a standing loop with write authority pointed at the repo. Corollary: before merging any PR, confirm its head branch was branched from _current_ main (a stale base + a shared-file slice = a silent collision that only surfaces at merge/rebase).

**Provenance:** PR #62, 2026-07-20. A `send_later` watcher (persistent session `session_01215A2y3UFrFDgpmWv3CrLQ`, watching PR #61) opened PR #62 for #52 at 07:24 UTC — ~3 min after that watcher fired at 07:21 — against main-before-#66. Surfaced when the founder asked why #62 was still WIP; the loop was disabled and #62 rebased + gated + de-collided (tests renumbered `RT-21/22/23`).

---

## P-004 · The guarantee-gate scan list must be derived MECHANICALLY from what the artifact renders — re-checked on every change to either

**Symptom:** The prohibited-guarantee gate (`no-prohibited-guarantee.ts`) exists to stop a model from smuggling an employment/salary/interview guarantee into a founder-facing artifact. It only catches guarantees in the fields listed in its `selectText`. **Four times** across the agent slices, a model-authored field was **rendered into the artifact by `buildBodyMarkdown` but omitted from `selectText`**, leaving a live guarantee-leak: P1.4b `objection.sourceRef` (#74), P1.4c-2 `recommendedDueAt`, and P1.4c-2 `channel` (#79). Every time, an in-code comment confidently asserted "these are the ONLY free-text fields" — and every time it was wrong. Worse, on #79 a **fix itself widened** a leak: making non-contact actions consent-exempt removed an incidental check on `channel` without extending the scan.

**Cause:** the scan list is maintained by human/model judgment ("these look like the free-text fields") instead of being derived from the render function. Any field added to `buildBodyMarkdown`, any constraint removed from a field, or any gate change that stops validating a rendered field, silently opens a hole the green test suite does not see — because the tests only inject guarantees into the fields someone remembered to test.

**Rule:** for every agent with a `noProhibitedGuaranteeGate`, treat the scan list as a **mechanical enumeration of `buildBodyMarkdown`**: list every value it renders, classify each as exactly one of (i) input-derived (not model output), (ii) a closed Zod enum, (iii) gate-validated against a set, or (iv) scanned by `selectText`. If a rendered model-authored value is none of (i)-(iv), it is a leak — scan it or don't render it. Re-run this enumeration on **any** change to `buildBodyMarkdown`, the output schema, OR a gate's coverage (a fix counts). Prefer structural constraints (`.datetime()`, enums, deriving from a closed enum) over relying on the scan. Never trust a "these are the only free-text fields" comment — regenerate the classification. A guarantee-in-`<field>` test is not optional coverage; add one per scanned field.

**Provenance:** PRs #74 (`sourceRef`), #79 (`recommendedDueAt`, then `channel`), 2026-07-20/21. The #79 3-layer gate found two; its fix re-verify caught a third that the fix had introduced; a second re-verify with a forced exhaustive `buildBodyMarkdown`↔`selectText` enumeration confirmed complete coverage. Each leak was structurally invisible to a green suite.

---

## P-005 · One tuning constant, two call sites with OPPOSITE requirements — and a constants-only test that cannot see it

**Symptom:** Live run 4 failed **7 of 8** briefs at stage 5 with `"Request timed out."`, `gates=0`, `tok=0/0`, latency pinned at ~37s for every failure. The one survivor took 61.5s and emitted 1014 output tokens. This was strictly worse than the bug it replaced: run 3 blocked 4 briefs but at least _produced_ them; run 4 produced nothing at all. The ~677 hermetic tests were green throughout, including a test written specifically to guard this setting.

**Cause:** two layers.

1. `ANTHROPIC_PER_ATTEMPT_TIMEOUT_MS = 12_000` was set on the **shared** `AnthropicModelClient` (`timeout:` in the constructor). It was sized for the guarantee classifier's ~200-token verdicts. The same client also serves **generation** calls, which emit up to 4096 tokens and legitimately run tens of seconds. `12s x (2 retries + 1) = 36s` — exactly the observed latency. One constant, two workloads whose requirements point in opposite directions.
2. The guard test, `FOS1-GCLS-timeout-01`, asserted `GUARANTEE_CLASSIFIER_TIMEOUT_MS > PER_ATTEMPT x (MAX_RETRIES + 1)` — two constants compared to each other. That assertion gets **easier** to satisfy as `PER_ATTEMPT` falls, so it applied downward pressure to the very number generation needed to be large. It was green at 12s and would stay green at 1s. It could never observe that the value reached the SDK, let alone that it was appropriate there.

**Rule:**

- **Before setting a tuning constant on a shared client, enumerate its call sites and their requirements.** If two call sites want the value moved in opposite directions, the constant does not belong on the client — push it to the call site (an optional per-call parameter) and make the **safe direction the default**, so a caller who forgets is slow rather than starved.
- **Assert on the value that will actually be enforced, not on the constant.** For the Anthropic SDK the resolved per-attempt timeout is observable through the already-injected `fetchImpl` as the `X-Stainless-Timeout` header (whole seconds) — verified empirically, not assumed. Reading it turns "the number is 120000" into "a generation call is actually given 120s."
- **Check the direction a relational assertion applies pressure in.** `expect(A).toBeGreaterThan(B * k)` constrains the _pair_; it silently licenses driving `B` to zero. If `B` also has a floor, that floor needs its own assertion, in the opposite direction, anchored to a **measurement** rather than to another constant (here: the slowest observed healthy live run, 61.5s).
- Scope a relational assertion to constants used by **one** workload. Pointing it at a shared constant is what let this pass review.

**Provenance:** PR #132 introduced it (P1.10j, fixing the run-3 timeout-as-verdict bug); live run 4, 2026-07-27, exposed it; P1.10n fixed it by making the timeout per-call-site (`GenerateStructuredInput.perAttemptTimeoutMs`, default `ANTHROPIC_GENERATION_TIMEOUT_MS = 120_000`; the classifier passes `ANTHROPIC_CLASSIFIER_TIMEOUT_MS = 12_000`). The replacement tests (`FOS1-RT-10`) were demonstrated to FAIL against the 12s default before the fix was kept.
