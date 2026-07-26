# Engineering Evaluation — FOS vs. KorroAi/mue-x

**Date:** 2026-07-24 · **Evaluator:** Claude (Opus 5) · **Method:** empirical — both repos cloned, read, and executed.

## Subjects

| | FOS | MUE-X |
|---|---|---|
| Repo | `drdgreed/Founder-Operating-System-FOS` (id 1302992699) | `KorroAi/mue-x` |
| Purpose | Canonical system-of-record + governed agent teams for a solo founder | Self-modifying agent that rewrites its own Python source in a loop |
| Language | TypeScript (Next.js, Drizzle, Postgres) + Python eval sidecar | Python 3.11, stdlib-only core |
| Size | ~33,900 lines source, 68 test files | 12,399 lines, 1 test file |
| History | 122 PRs, adversarial-verifier gate per slice | 10 commits, 1 author, codebase in one initial commit |
| Runs today? | No — no deploy config, no worker process | Yes — `python -m mue`, zero deps |

**These are not competitors.** Scoring is on engineering dimensions, not feature parity.

---

## Scores

| # | Dimension | FOS | MUE-X |
|---|---|---:|---:|
| 1 | Architecture & domain modeling | **9** | 4 |
| 2 | Safety, governance & security posture | **8** | 2 |
| 3 | Test & verification rigor | **8.5** | 1 |
| 4 | Engineering process & traceability | **9** | 2 |
| 5 | Operability (deploy, runtime, observability) | 3 | 3 |
| 6 | Documentation honesty (claims vs. code) | 5 | 3 |
| 7 | Delivered, usable value today | 4 | **6** |
| | **Weighted overall** | **7.0** | **3.0** |

---

## Justifications

### 1. Architecture — FOS 9 / MUE-X 4

**FOS.** Event-sourced canonical core with append-only enforced *at the database level*, not by convention (`packages/db/migrations/0001_append_only_operational_event.sql`, `0003_artifact_version_content_immutable.sql`, `0020_append_only_campaign_touch.sql`). Optimistic concurrency with a real-Postgres CAS test. The founder-facing surface (Notion) is a projection + command layer behind a provider-neutral adapter — swappable, never the source of truth. The agent runtime (`packages/agents/src/pipeline.ts`) confines non-determinism to exactly one of twelve stages; stages 6–7 enforce over whatever the model produced. That is the correct shape for LLM systems and most projects get it wrong.

Point deducted for two real drifts from the stated design:
- `packages/contracts` is 2 files / 351 lines. `PHASE-1-IMPLEMENTATION-MAP.md:47` says agent I/O + gate schemas belong in `packages/contracts/src/agents/*`; they live in `packages/agents` instead. The shared-contract boundary is thinner than the architecture claims.
- Governance registries (consent, claims, offers, pathways) are **not canonical entities**. See §2.

**MUE-X.** The `mue/evo/` subpackage split is sane and the AST-mutation concept is genuinely novel. But `core.py` is a god object wiring ~20 subsystems with no interfaces or injection; optional dependencies are handled by `try/except ImportError`; there is no packaging metadata at all (no `pyproject.toml`, no `setup.py`) despite documenting `python -m mue`. Most seriously, `Solidifier.validate()` (`mue/evo/evolution/solidify.py:60`) **writes the gene file to disk as a side effect of validation** — and the rollback snapshot at Gate 4 is only taken `if gene_name in self.genome.genes`, so a newly-created gene is written with no rollback path.

### 2. Safety & governance — FOS 8 / MUE-X 2

**FOS.** Fail-closed is applied consistently and deliberately: an unconfigured feature flag reads as disabled and defaults to the least-privileged mode (`pipeline.ts:88-95`); an absent contact purpose *or* an absent channel blocks contact (`gates/contact-consent.ts`); an approved-claim entry lacking a parseable effectiveness window fails closed (`gates/claims-approved-for-channel-and-offer.ts`). Gates read only Zod-validated `input`/`output`, never the model's own assertion of policy — the single most important property in an agentic system, and it is stated as an explicit ADR-07 D9 invariant rather than left implicit. There are prompt-injection fixtures per agent and a guarantee classifier with a recall-paramount adversarial corpus. Auth is a constant-time bearer-token service shim that binds workspace and actor from server config, never from the request body (`apps/api/lib/auth.ts`) — correct anti-tenant-forgery design.

Two points deducted for one structural gap the code itself flags:

> `FLAG (issue #116): consent registry not seeded — this gate operates on a caller-provided grant list … NOT a live consent-service lookup.`
> — `packages/agents/src/gates/contact-consent.ts:31-36` (same flag on the claims gate)

The gates are correct, but their trust boundary is one level too shallow: **the guarantee is only as strong as whatever allowlist the caller passes in.** There is no `consent_record`, `product_claim`, or `offer` table in `packages/db/src/schema/`. In production a caller bug silently widens policy with no canonical record to audit against. This is the difference between "we have consent gates" and "we cannot contact without recorded consent."

**MUE-X.** The safety story does not survive reading the code.

- **The "sandbox" executes the untrusted code it is supposed to be protecting against.** `GeneSandbox.test_gene` (`mue/evo/dna/sandbox.py:76-85`) imports the mutated module and then **calls every public no-arg function in it**, in a subprocess running as the same user with full filesystem and network access. The module docstring says it exists to prevent `os.system("rm -rf /")`. It would invoke it. `Solidifier.validate()` Gate 2.5 calls this on every mutation.
- **Both safety layers are substring denylists.** `DANGEROUS_COMMANDS` is 10 literal strings (`guard.py:19-30`); `Solidifier`'s prohibited-pattern list is 6 (`solidify.py:41`). The latter blocks `subprocess.call(` but not `subprocess.run(`; blocks `__import__('os').system(` but not `import os` + `os.system(`; blocks `shutil.rmtree` but not `os.remove` or `Path.unlink`. Denylists are the wrong primitive here, and these are unusually porous ones.
- **The audit log fails open and is not tamper-evident.** `SecurityGuard._persist` swallows every exception with the comment *"Audit log failure shouldn't crash the agent"* (`guard.py:141-146`). It is a plain mutable JSONL file in the agent's own writable tree.
- The module docstring asserts *"The agent CANNOT disable this module."* The mechanism is a two-entry relative-path denylist consulted only by callers that voluntarily call `allow_write`.

For a system whose entire premise is unsupervised self-modification in a `while`-loop that auto-git-commits its own mutations, this is the wrong end of the risk curve.

### 3. Test rigor — FOS 8.5 / MUE-X 1

**FOS — verified this session:**
```
$ npm test
Test Files  63 passed | 4 skipped (67)
     Tests  598 passed | 4 skipped (602)
  Duration  144.84s
```
Coverage is behavioral, not decorative: real-Postgres concurrency tests for the CAS path, PGlite migration round-trips, per-gate adversarial corpora, prompt-injection fixtures, and a stubbed-fetch contract test for the live Gmail client. Deducted for: no coverage measurement or threshold in CI, 4 unexplained skips, and the eval suite never executing (§5).

**MUE-X.** One test file, `mue/test_absorption.py`. It is not a pytest test — it is a manual script requiring `cwd=mue/`, and CI never invokes it. Run directly it does not even collect:
```
$ python3 -m pytest mue/test_absorption.py -q
E   ModuleNotFoundError: No module named 'evo'
```
CI (`.github/workflows/ci.yml`) runs three checks: `import MueAgent` succeeds, no file exceeds 800 lines, no `.db` files committed. **Zero behavioral coverage over 12,399 lines**, including six AST transformers that rewrite source code in place.

### 4. Process — FOS 9 / MUE-X 2

**FOS.** 122 PRs, each one bounded mechanically-gradeable slice, each gated by two independent fresh-context adversarial verifiers before merge. Nine ADRs. A live traceability matrix (`docs/planning/PHASE-1-IMPLEMENTATION-MAP.md`) mapping every work package → slice → repo location → migration → test prefix → feature flag. A per-repo `docs/AGENT_LESSONS.md`. Known gaps are filed as issues and referenced from the code that has them (`FLAG (issue #116)`). This is materially better than most funded startups.

**MUE-X.** Ten commits, one author, entire codebase in a single initial commit. No PRs, no ADRs, no issues, no traceability. The largest document in the repo is `LAUNCH-KIT.md` (341 lines) — marketing exceeds technical documentation, and an arXiv-ready LaTeX paper was committed for a system with no passing tests.

### 5. Operability — FOS 3 / MUE-X 3

**This is FOS's weakest dimension by a wide margin, and it is where MUE-X is genuinely ahead.**

FOS cannot be started by anyone, including you:
- **No deployment configuration of any kind** — no Dockerfile, no `railway.json`, no `fly.toml`, no deploy workflow. The README's stack table says "CI/Deploy: GitHub Actions · Railway."
- **No worker process.** `apps/worker/src/index.ts` is one line: `export * from "./stalled-opportunity-job.js";`. `@fos/worker`'s `package.json` has no `start` and no `build` — it is a library, not a process.
- **No job queue.** No job/queue table exists in `packages/db/src/schema/`. The README says "Jobs: Postgres-backed queue · persistent worker." `stalled-opportunity-job.ts:21` is candid: *"the scheduling/cron wiring itself is [not built]."* The spec calls for 12 background jobs; 1 exists, unscheduled.
- **No structured logging, metrics export, health check, or alerting.** Observability across ~34k lines is two `console.error` calls in `pipeline.ts`.
- `apps/api` has `dev` and `build` but no `start`.

MUE-X scores the same 3 for the opposite reason: it starts instantly with zero dependencies and no configuration, but has no logging framework, no config schema, no packaging metadata, and no versioning.

### 6. Documentation honesty — FOS 5 / MUE-X 3

**FOS has a split personality.** In-code documentation is exemplary — comments cite spec sections, name the founder decision behind each choice, and mark their own gaps with `FLAG (issue #NNN)`. I did not find a single overclaiming comment.

The README is the opposite, and it is the artifact everyone reads first. It currently states *"No application code yet"* (8 days stale, ~34k lines exist), and claims three capabilities that are absent: the Postgres-backed queue, the persistent worker, and "Evals as a gate." **`fos-evals/` is a 72-line stub** — `runner.py` defines `GateOutcome`, `FixtureResult`, and a `promotable()` threshold, and its own README says *"Scaffold only."* There is no fixture loader, no grader, and no CLI. **37 eval fixtures have been authored across 6 agents and not one of them has ever been executed.** The CI `python-evals` job runs `ruff` plus two arithmetic assertions about the threshold function.

The practical consequence: the shadow → founder-review → live promotion ladder — the core safety mechanism of the whole design — **has no gate behind it.**

**MUE-X** asserts properties its code contradicts, in the safety-critical path (§2). "Prevents a rogue gene from taking down the whole agent" describes a component that executes rogue genes.

### 7. Delivered value today — FOS 4 / MUE-X 6

MUE-X wins this one and it is worth sitting with. You can `git clone && python -m mue` and something happens. 230 stars. FOS has ~34k lines of better-engineered code, and the founder it was built for cannot run it. Phase 1.10 (eval suite + shadow mode + flag activation) has not started; the only things that have touched production reality are two one-shot scripts (`scripts/notion-live-setup.ts`, `scripts/gmail-live-draft.ts`).

---

## What FOS should take from MUE-X

Architecturally: nothing. Copying MUE-X's safety model into FOS would be a severe regression. But three lessons are real:

1. **Runnability is a feature, and it is currently absent.** MUE-X's zero-dependency single-entrypoint start is worth more than it looks. FOS should be `docker compose up` away from a working local instance.
2. **The README is the product's first impression.** MUE-X's is dishonest but effective; FOS's is honest-in-code but stale and undersells 122 PRs of real work.
3. **Ship the loop as an asset.** FOS's adversarial-verifier build loop is more valuable and more novel than MUE-X's AST mutation — and it actually works. It is currently one paragraph in a README.

---

## Recommendations (ranked by value ÷ effort)

| # | Recommendation | Why | Effort |
|---|---|---|---|
| **R1** | **Rewrite the README to match reality** | It is the only artifact asserting things the code does not do. Removes the "is this even implemented?" question entirely. | 1 hr |
| **R2** | **Build the eval runner + wire it as a CI gate** | 37 fixtures never execute; the promotion ladder has no gate. This is the single largest claimed-but-absent capability. | 1–2 days |
| **R3** | **Make it deployable: Dockerfile + compose + Railway config + `/health` + migrate-on-deploy** | Nothing runs anywhere. Unblocks every subsequent phase. | 1–2 days |
| **R4** | **Job queue table + real worker process + scheduler** | Claimed in README, absent in code. 1 of 12 spec'd jobs exists and nothing invokes it. | 2–3 days |
| **R5** | **Canonicalize the governance registries** (`consent_record`, `product_claim`, `offer`) and have gates read from the DB | Closes issue #116. Converts "the caller passed the right allowlist" into an enforced, auditable invariant. Required before any live agent contacts a human. | 3–5 days |
| **R6** | **Structured logging + run metrics + cost/token budget per agent** | Two `console.error` calls is not observability for a system that spends money on model calls. ADR-07 promises per-agent budgets; `model-client.ts` hardcodes `max_tokens: 4096`. | 1–2 days |
| **R7** | **CI hardening: coverage threshold, `npm audit`/Dependabot alerts, migration-drift check** | Cheap ratchets on an already-strong suite. | 0.5 day |
| **R8** | **Extract the adversarial build loop into a documented, reusable asset** | Your most differentiated IP, currently undocumented outside one README paragraph. | 1 day |

**Sequencing:** R1 immediately (it is 1 hour and removes a false impression). Then R3 → R2 → R4 as one "make it real" arc, because a deployed instance is what makes evals and jobs meaningful rather than theoretical. R5 before *any* agent goes past shadow mode. R6–R8 opportunistically.

**Do not do:** add features, start Phase 2, or add agents. FOS's problem is not capability — it is that ~34,000 lines of well-engineered capability cannot currently run.

---

## Checkpoint

**Weakest points in this evaluation.**
1. The weights behind the 7.0 / 3.0 overall scores are my judgment, not a defined rubric — I weighted operability and delivered value heavily because both systems' gaps cluster there. Reasonable people would weight architecture higher and score FOS ~8.
2. I read MUE-X's safety-critical paths (sandbox, guard, solidify, pipeline) closely but skimmed `mutator.py`, `github_miner.py`, and `loop.py` (~2,100 lines). My "6 AST strategies" characterization is from the README, not from reading all six.
3. I did not assess FOS's `packages/adapter` (7,008 lines) or `packages/notion` in depth; the Notion reconciliation logic could hold problems I did not surface.

**Unverified.**
- Whether FOS's CI is currently green on `origin/main` — I ran the suite locally (598 passed) but did not check GitHub Actions run status.
- MUE-X's 230 stars and last-push date are from the GitHub API; I did not assess whether the evolution loop actually improves the agent (nothing in the repo measures this, which is itself the finding).
- Whether a Railway project already exists outside the repo. I checked only for in-repo configuration.

**Load-bearing assumption.** That FOS's goal is a system you will actually operate, not a portfolio artifact demonstrating engineering rigor. If it is primarily a showcase, R3/R4/R6 drop sharply in priority and R1/R8 become nearly the whole list. **This changes the recommendation ordering more than any other single fact — confirm before spec'ing.**

**Needs human verification.** R5 touches consent and marketing-contact law (CAN-SPAM / GDPR-adjacent). The gate logic is sound as engineering, but which consent purposes are legally required, and what counts as an affirmative recorded grant, is a question for counsel — not for me and not for the model.
