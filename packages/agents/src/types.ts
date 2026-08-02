import type { ZodType } from "zod";
import type { EventActor } from "@fos/contracts";
import type { ArtifactDomain, ArtifactType } from "@fos/db/schema";
import type { CreateArtifactResult, Db } from "@fos/db/services";
import type { NotionClient } from "@fos/notion";
import type { Gate } from "./gates/gate.js";
import type { ModelClient, ModelUsage } from "./model-client.js";
import type { PromptVocabulary } from "./prompt.js";
import type { FeatureMode } from "./mode.js";

/** Who/what triggered a run (stage 1, trigger validation). */
export interface RunTrigger {
  type: string;
  source: string;
}

/** Per-invocation context supplied by the caller (not part of the versioned definition). */
export interface RunAgentContext {
  workspaceId: string;
  productId?: string | null;
  actor: EventActor;
  trigger: RunTrigger;
  correlationId?: string;
  causationId?: string | null;
}

/**
 * Runtime dependencies (stage 5's #1 safety property lives here):
 * `modelClient` is REQUIRED with no default — constructing a call to
 * `runAgent` without one is a type error, so no hermetic test can ever reach
 * a real Anthropic call. `notionClient` is optional — only definitions that
 * declare a `projection` hook need it.
 */
/** The verdict shape the stage-7b semantic compliance reviewer returns. Mirrors
 * `GuaranteeDecision` from the guarantee classifier so the default reviewer
 * (which wraps `evaluateGuaranteeText`) satisfies it structurally. */
export interface ComplianceReviewDecision {
  verdict: "allow" | "block";
  reason: string;
  /** Tokens this review cost, when a model call was made. Threaded so stage-7b
   * spend reaches `agent_run.costJson`; before this it was invisible (F-J). */
  usage?: ModelUsage;
}

/**
 * The stage-7b semantic compliance reviewer (Option C slice 2, issue #109): an
 * async classifier over ONE free-text field of the validated model output. The
 * pipeline DEFAULTS this to the eval-validated two-tier guarantee classifier
 * (`evaluateGuaranteeText`) wired to `deps.modelClient`; it is an INJECTABLE
 * dependency so tests can stub the compliance decision WITHOUT scripting
 * classifier calls through the generation `FakeModelClient` (the two model
 * seams stay decoupled).
 */
export type ComplianceReviewer = (
  text: string,
  options?: ComplianceReviewOptions,
) => Promise<ComplianceReviewDecision>;

export interface ComplianceReviewOptions {
  /**
   * May the tier-1 regex floor return a FINAL block for this text?
   *
   * `true` (the default) is today's behaviour: a floor match is unappealable.
   * `false` means a floor match ESCALATES to the tier-2 semantic classifier
   * instead — never that the text is allowed. See `ComplianceReviewText.voice`.
   */
  floorIsFinal?: boolean;
  /** The output FIELD NAME this text came from (F-AA). Definition-authored
   * static policy, never input-derived — surfaced to tier 2 as framing so a
   * bare fragment from a prohibition list is not read as a promise. */
  field?: string;
}

/**
 * A reviewable text plus the PROVENANCE the floor policy is derived from.
 *
 * Exists because of F-K. The tier-1 floor is a proximity regex: it fires on
 * `guarantee` near an employment noun. That is correct for a sentence the agent
 * ASSERTS, and wrong for one that DESCRIBES its input — and three consecutive
 * live runs blocked the `prompt_injection` fixture on the agent's own correct
 * report of the attack it had just detected ("...attempting to force ... a
 * guaranteed job/interview"). A floor block is final, so tier 2 could never
 * correct it.
 *
 * The rejected alternative was a lexical attribution guard (`contains`,
 * `demands`, `says`). It fails for two reasons found while designing this:
 * an assertion can be laundered by APPENDING one ("We guarantee a job, as the
 * brochure says."), and attribution verbs are open-class content words that
 * frequently are not attribution at all ("Our program contains a guaranteed
 * interview slot"). It would also be a judgment-maintained list guarding the
 * one unappealable check — the P-004 shape, in the worst possible place.
 *
 * Field provenance is instead MECHANICAL: a definition already knows which of
 * its output fields exist to describe untrusted input, because it declares
 * them. The signal comes from the schema, not from guessing at English.
 */
export interface ComplianceReviewText {
  text: string;
  /** The output field this came from. Diagnostics, and the anti-drift check. */
  field: string;
  /**
   * - `own_voice` — the agent asserting something itself. FULL floor applies.
   * - `reports_input` — a field whose PURPOSE is to describe untrusted input.
   *   The floor may not rule finally here; tier 2 (which reads meaning) decides.
   *
   * A bare `string` normalises to `own_voice`, so an untagged definition keeps
   * exactly today's behaviour. That default is the FAIL-SAFE direction: the
   * cost of forgetting to tag is a possible false block, never a missed one.
   */
  voice: "own_voice" | "reports_input";
}

export interface RunAgentDeps {
  db: Db;
  modelClient: ModelClient;
  notionClient?: NotionClient;
  /**
   * Optional injectable semantic compliance reviewer (stage 7b). Omitted in
   * production, where the pipeline defaults to the two-tier guarantee
   * classifier over `modelClient`. Injected by hermetic tests so the
   * compliance mock is decoupled from the generation model mock.
   */
  complianceReviewer?: ComplianceReviewer;
  /**
   * How many stage-7b compliance-review texts may be classified at once.
   * Defaults to `DEFAULT_COMPLIANCE_REVIEW_CONCURRENCY`. The texts are
   * independent — each is a separate classification of a separate string — so
   * reviewing them one at a time made a successful run's latency the SUM of
   * every classifier call. A real enrollment brief renders 12-20 reviewable
   * texts, which dominated live-run wall time.
   *
   * Set to 1 to force the original strictly-sequential behaviour (tests that
   * assert call ordering do this).
   */
  complianceReviewConcurrency?: number;
}

export interface ArtifactSpec<TInput, TOutput> {
  /**
   * The canonical artifact type. Either a single static value (the common
   * case) OR a function of the run's input/output for agents whose artifact
   * type is DRIVEN by their input — e.g. `fos.personalized_follow_up` (issue
   * #82), whose `followUpType` selects one of the six §7.1 follow-up types.
   * Backward-compatible: a plain `ArtifactType` still satisfies this. The
   * resolved value must always be a member of the canonical `artifact_type`
   * enum (a function cannot widen it — its return type is `ArtifactType`).
   */
  artifactType: ArtifactType | ((input: TInput, output: TOutput) => ArtifactType);
  domain: ArtifactDomain;
  buildTitle(input: TInput, output: TOutput): string;
  buildBodyMarkdown(input: TInput, output: TOutput): string;
  buildClaimsManifest?(input: TInput, output: TOutput): unknown;
}

export interface SecondaryEvalResult {
  passed: boolean;
  notes?: string;
}

export interface EvalPolicy<TInput, TOutput> {
  /** Advisory only (D2 stage 8 is "optional secondary quality eval") — recorded
   * in `agent_run.secondary_eval_json` but never blocks a run; only stages 6-7
   * enforce. */
  secondaryEval?: (
    input: TInput,
    output: TOutput,
  ) => SecondaryEvalResult | Promise<SecondaryEvalResult>;
}

export interface ProjectionHookContext {
  deps: RunAgentDeps;
  runContext: RunAgentContext;
  mode: FeatureMode;
}

export interface PersistDomainHookContext {
  /**
   * IMPORTANT (issue #63): `deps.db` here is a TRANSACTION handle — the hook
   * runs inside the stage-9 transaction, so all its DB writes commit/roll back
   * atomically with the artifact. A throw rolls the whole stage back. Corollary:
   * this hook is for CANONICAL DB writes ONLY. Do NOT perform non-idempotent
   * external side effects here (email/HTTP/Notion) — the tx cannot roll those
   * back, and they re-execute on retry. External effects belong in the isolated
   * stage-11 `projection` hook. (Other `deps` clients, e.g. `notionClient`,
   * remain reachable but must not be used for side effects in this hook.)
   */
  deps: RunAgentDeps;
  runContext: RunAgentContext;
  agentRunId: string;
}

/**
 * Agent-definition contract (ADR-07 D3): versioned CODE, not data. Definitions
 * live in `src/definitions/` and are registered by `key`.
 */
export interface AgentDefinition<TInput, TOutput> {
  key: string;
  version: string;
  objective: string;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  /** Defaults to DEFAULT_MODEL (Sonnet) when omitted. */
  model?: string;
  permittedTools: readonly string[];
  permittedMemoryScopes: readonly string[];
  /** The highest mode this agent's code permits, regardless of the workspace
   * feature-flag's configured mode (see mode.ts effectiveMode). */
  autonomyCeiling: FeatureMode;
  deterministicGates: ReadonlyArray<Gate<TInput, TOutput>>;
  /**
   * Optional stage-7b semantic compliance-review selector (Option C slice 2,
   * issue #109). Returns the model FREE-TEXT fields of the validated output the
   * semantic guarantee classifier must scan — the SAME role the removed keyword
   * gate's `selectText` played, but enforced by the eval-validated two-tier
   * classifier (which reads MEANING) in a SEPARATE async pipeline stage rather
   * than a pure/sync deterministic gate. Omitted by definitions with no
   * founder-facing free text to review (e.g. the `fos.smoke` stub), which skip
   * the stage cleanly. Select ONLY Zod-validated output fields (never raw
   * prompt/input), exactly like a gate (D9).
   */
  complianceReviewText?: (output: TOutput) => ReadonlyArray<string | ComplianceReviewText>;
  /**
   * Optional closed vocabularies for output fields whose legal values come from
   * the run's input (P1.10e). Surfaced to the model in the prompt's user turn;
   * the RULE about copying them verbatim is static policy in the system prompt,
   * so an input-derived string can never reach the policy channel (D9).
   *
   * Each entry MUST be produced by the same selector the corresponding gate
   * enforces with — see the shared selectors in `definitions/enrollment-brief.ts`.
   * A vocabulary that drifts from its gate is worse than none: the model would
   * be confidently told the wrong answer.
   */
  promptVocabularies?: (input: TInput) => ReadonlyArray<PromptVocabulary>;

  evalPolicy?: EvalPolicy<TInput, TOutput>;
  /** `feature_flag.key` this definition reads at stage 2. */
  featureFlagKey: string;
  artifact: ArtifactSpec<TInput, TOutput>;
  /**
   * Optional stage-9 domain-persistence hook (issue #53): writes the agent's
   * own domain-specific canonical record (e.g. `enrollment_assessment`) right
   * after `createArtifact`, INSIDE stage 9's try block. Unlike the isolated
   * stage-11 projection, a `persistDomain` failure IS a run failure — this is
   * canonical state, not a best-effort external side effect, so it must fail
   * closed like any other stage-9 write. Optional: omitted by definitions
   * with no domain record to persist (e.g. the `fos.smoke` stub), which keep
   * working unchanged. NOTE (issue #63): runs INSIDE the stage-9 transaction —
   * `ctx.deps.db` is a tx handle; canonical DB writes only, no external
   * side effects (see PersistDomainHookContext).
   */
  persistDomain?: (
    ctx: PersistDomainHookContext,
    input: TInput,
    output: TOutput,
    artifactResult: CreateArtifactResult,
  ) => Promise<void>;
  /**
   * Optional stage-11 projection hook (REUSE `projectOpportunity`-shaped
   * adapters). Omitted by definitions with nothing to project (e.g. the
   * `fos.smoke` stub) — the stage then no-ops. Never invoked in shadow mode
   * (shadow: persist, don't surface).
   */
  projection?: (ctx: ProjectionHookContext, input: TInput, output: TOutput) => Promise<void>;
}
