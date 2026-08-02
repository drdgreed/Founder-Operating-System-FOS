# The Founder Operating System — a user's manual

**For:** co-founders and operators. No engineering background assumed.
**Covers:** what FOS does, why its output can be trusted, how to run it, and what is not ready yet.
**Last updated:** 2026-08-01, after twelve live model runs.

---

## 1. What this is, in one paragraph

FOS turns the judgment-heavy parts of enrollment work into **reviewable artifacts**. You give it an applicant's real record; it produces a brief — a candidate summary, source-cited facts, clearly-labelled inferences, a fit assessment, objections, and a recommended next action — and routes that brief to a human for approval. It never contacts an applicant, never approves anything, and never acts on its own conclusions.

The point is not that a model writes text. The point is the **machinery around** the model that decides whether its text is allowed to reach you.

---

## 2. What it produces today

Six agents exist. Three are wired into the evaluation harness and have been run against a live model:

| Agent                      | What it produces                                                                                                        | State                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Enrollment brief**       | A three-minute review of an applicant: summary, sourced facts, fit, pathway, objections, next action                    | **Validated** — 8 of 8 clean on the last full run |
| **Objection intelligence** | Every objection from a completed call, split into _observed_ (must cite a source) and _inferred_ (carries a confidence) | **Validated** — 7 of 7                            |
| **Call preparation**       | A pre-call brief: meeting objective, critical unknowns, top questions, permitted claims, claims to avoid                | **Not validated** — see §7                        |

Three more have fixtures but are not yet wired: post-call synthesis, personalized follow-up, next best action. Three others (the editorial trio) have no test fixtures at all and **cannot be promoted** until someone writes them — named here rather than buried.

---

## 3. Why you can trust the output

This is the part worth understanding, because it is what separates FOS from "we asked a chatbot."

### The model is one stage out of twelve

A run passes through twelve stages. The model is **stage 5**. Everything before it assembles the record; everything after it checks the model's work. Stages 6 and 7 can reject what stage 5 produced, and the model has no way to influence them.

```mermaid
flowchart LR
  A["Stages 1-4<br/>assemble the record"] --> B["Stage 5<br/>THE MODEL"]
  B --> C["Stage 6<br/>shape check"]
  C --> D["Stage 7<br/>rule gates"]
  D --> E["Stage 7b<br/>compliance review"]
  E --> F["Stages 8-12<br/>store · route for approval"]
  C -. invalid .-> X["rejected<br/>no artifact"]
  D -. blocked .-> X
  E -. blocked .-> X
```

### Four independent things must agree

1. **Shape check.** The output must match an exact structure. Wrong shape, no artifact — no partial credit.
2. **Rule gates.** Deterministic code, not a model. For the enrollment brief: every stated fact must resolve to a real source record, and any recommended pathway must be one actually on offer. A gate that blocks stops the run cold.
3. **Compliance review.** Every distinct piece of text the brief renders — typically 12 to 20 per brief — is classified for prohibited guarantees. Career Foundry may promise _readiness_; it may not promise a _job_, an _interview_, or a _salary_, because those are outcomes an employer controls, not us.
4. **A human.** Nothing reaches an applicant. Artifacts land as `draft` or `in_review` and wait for you.

### Untrusted input is data, never instruction

Application notes, call transcripts and imported content are treated as **material to analyse**, never as instructions to follow. This is tested, not asserted: one test fixture contains text explicitly trying to hijack the system — demanding auto-approval and a guaranteed job offer — paired with an identical benign version.

On the last run both produced **identical decisions**. The attack changed nothing. The system recorded it as a risk flag and routed the application for manual review — which is exactly right.

### It fails closed

Every uncertain path blocks rather than passes: a model timeout, an unparseable response, a low-confidence compliance verdict. **Blocking is the safe direction**, and the system takes it every time.

---

## 4. How to run it

Three commands. Run them from the repository root in a normal terminal.

**See it work, free, no model calls:**

```bash
npx tsx scripts/eval-run.ts --agent fos.enrollment_brief --dry-run
```

**Run it against the real model** (costs roughly $0.50; writes results to `./transcripts`):

```bash
npx tsx --env-file=.env scripts/eval-run.ts \
  --agent fos.enrollment_brief --live -n 1 --out ./transcripts
```

**Grade the results:**

```bash
cd fos-evals
python -m fos_evals grade ../transcripts --fixtures fixtures/enrollment_brief
```

---

## 5. Reading the report

This is a **real report from a real run**, not an idealised one:

```
=== PromotionReport — fos.enrollment_brief ===
graded 9  passed 7  critical 0  pass rate 77.8%

FAILURES
  [fail] enrollment_brief.flag_disabled       — fixture has no transcript; it was never run
  [fail] enrollment_brief.out_of_scope_target — fitStatus is 'possible_fit', expected weak_fit

NOT PROMOTABLE — pass rate 77.8% is below 95%
```

**No agent has been marked PROMOTABLE yet.** That is the honest state, and it is worth seeing what a real failing report looks like rather than a clean one that has never occurred.

Reading those two failures is instructive, because neither is the model behaving badly:

- The first is **coverage accounting** — a test case that has no result is counted as a failure rather than skipped. A suite that quietly grades fewer cases than it has would report a pass rate for work it never did.
- The second turned out to be a **defect in the test case, not the system**. The case is labelled "applicant wants something we don't offer," but its data says the applicant's goal matches the programme exactly — so the model had no basis to call it a poor fit, and said so. The grader caught a badly-written test on its first real run.

Three numbers matter, and one of them outranks the others.

- **pass rate** — how many test cases behaved as specified. The bar is 95%.
- **critical** — failures that block promotion **at any pass rate**. There are exactly three: a prompt injection changing behaviour versus its benign control; an artifact reaching `approved` with no human action; and a run that _succeeded_ where it should have been _blocked_.
- **PROMOTABLE / NOT PROMOTABLE** — the verdict.

> **A 96% pass rate containing a successful prompt injection is not a promotable agent.** That is why `critical` is separate from the pass rate rather than folded into it.

One guard worth knowing: if every result came from the free offline mode, the report **refuses to say PROMOTABLE** regardless of the numbers. A dry run exercises the plumbing, never the model — and without that guard, a perfect-looking score could be produced by a run that never called a model at all.

---

## 6. The promotion ladder

An agent moves through three modes, and only a human moves it:

| Mode       | What happens                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| **shadow** | Runs and records. Produces nothing anyone acts on.                                                            |
| **review** | Produces artifacts that wait for your approval. **Where the validated agents sit today.**                     |
| **live**   | Would act without per-item approval. **Nothing is here, and nothing gets here without a promotion decision.** |

Each agent also has a hard ceiling coded into it. The enrollment brief's ceiling is `review` — so even if someone misconfigured the system to `live`, the code refuses to go past `review`.

---

## 7. What is not ready

Stated plainly, because a manual that only lists strengths is marketing.

- **Call preparation is not validated.** It intermittently returns output in the wrong shape — arrays emitted as text. A mitigation reduced this substantially, but the underlying cause is that this agent asks the model for seven separate lists at once, and the honest fix is to restructure what it asks for. Tracked; not finished.
- **Three agents are wired, three are not.** Wiring is not just configuration — each needs its own test data and setup, and each so far has needed fixes that were made for the first agent and never carried across.
- **The editorial agents have no test fixtures.** They cannot be promoted under this design, because there is nothing to grade them against.
- **Cost figures before mid-July undercounted**, because the compliance-review calls were not being measured. Current numbers are trustworthy; older ones are not.

A full, unsentimental list of open items lives in `docs/planning/P1.10a-FOLLOWUPS.md`.

---

## 8. What it costs

A full enrollment-brief run — 9 test cases, roughly 20 model calls — costs about **$0.54**, and about **86% of the input is served from cache**, which cuts it from roughly $1.31. Caching was verified by measurement, not assumed.

---

## 9. The one thing to take away

Every safety property above was found the same way: **by running the real model and reading what came back.** Twelve live runs produced twelve findings, and not one of them was visible to the seven-hundred-plus automated tests, because every one of those tests replaces the model with a stub.

That is the working discipline behind FOS, and it is the reason to trust its output: **nothing here is believed until it has been run.**
