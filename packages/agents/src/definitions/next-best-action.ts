import { eq } from "drizzle-orm";
import { z } from "zod";
import { enrollmentOpportunity } from "@fos/db/schema";
import {
  createActionRecommendation,
  OPPORTUNITY_STAGES,
  type OpportunityStage,
} from "@fos/db/services";
import type { Db } from "@fos/db/services";
import { consentGate } from "../gates/consent.js";
import { cooldownGate } from "../gates/cooldown.js";
import { featureModeAllowedGate } from "../gates/feature-mode-allowed.js";
import { lifecycleLegalGate } from "../gates/lifecycle-legal.js";
import { noDuplicateTaskGate, type ActionKey } from "../gates/no-duplicate-task.js";
import { noProhibitedGuaranteeGate } from "../gates/no-prohibited-guarantee.js";
import { noScheduledActivityConflictGate } from "../gates/no-scheduled-activity-conflict.js";
import { notTerminalStatusGate } from "../gates/not-terminal-status.js";
import { offerAvailableGate } from "../gates/offer-available.js";
import type { AgentDefinition } from "../types.js";

/**
 * Re-reads the target opportunity and asserts it belongs to this run's
 * workspace, mirroring `loadOwnedOpportunity` in `enrollment-brief.ts` /
 * `objection-intelligence.ts` (issue #73, same rationale those files gave for
 * not importing from one another): never trust a caller-supplied
 * `opportunity.id` across the workspace boundary. Small, intentional
 * per-file duplication of the pattern rather than a cross-agent dependency.
 */
async function loadOwnedOpportunity(db: Db, opportunityId: string, workspaceId: string) {
  const [row] = await db
    .select()
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.id, opportunityId))
    .limit(1);
  if (!row) {
    throw new Error(`fos.next_best_action: enrollment_opportunity ${opportunityId} not found`);
  }
  if (row.workspaceId !== workspaceId) {
    throw new Error(
      `fos.next_best_action: opportunity ${opportunityId} is not in workspace ${workspaceId}`,
    );
  }
  return row;
}

/**
 * `fos.next_best_action` (issue #78, spec §8.6) — the third P1.4 sub-slice,
 * completing the §9.3 stalled-opportunity/next-action substrate the founder
 * relies on across the enrollment lifecycle. The single most-gated agent in
 * the system: its entire job is to recommend a next action ONLY after ALL
 * eight deterministic guardrails (issue #77) pass, then write ONE
 * `EnrollmentActionRecommendation` (spec §6.6, issue #71) atomically.
 *
 * THREE hard properties (issue #78's 3-layer gate):
 *
 * 1. CONSENT IS FAIL-CLOSED, OPTION B (FOUNDER DECISION). `consentGate`
 *    (issue #77) was a DENYLIST — "option A" — with no production caller
 *    yet. It is generalized IN PLACE (see gates/consent.ts) to an ALLOWLIST:
 *    a proposed contact action's channel must be AFFIRMATIVELY present in
 *    the caller-supplied `consentedChannels` set, or the action is blocked —
 *    absent/empty/unknown consent is never a silent "allowed". This is the
 *    headline property the 3-layer gate verifies (see
 *    `FOS1-NBA-04-consent-unknown-blocks` below and the gate's own
 *    `FOS1-NBA-GATE-consent` unit tests).
 *
 * 2. ATOMIC CANONICAL WRITE, mirroring `enrollment-brief.ts`'s
 *    `persistDomain` pattern exactly (single-record write, not the N-record
 *    write `objection-intelligence.ts` mirrors): `persistDomain` re-asserts
 *    ownership FIRST, then writes exactly ONE
 *    `EnrollmentActionRecommendation` via `createActionRecommendation`
 *    (issue #71) INSIDE the stage-9 transaction the runtime already opens
 *    (issue #66/#63) — `deps.db` here is the tx handle, never re-wrapped in
 *    a second transaction. A rejected run (cross-workspace ownership
 *    failure) rolls back the write plus the artifact/version/event
 *    `createArtifact` wrote just before it — never an orphaned
 *    recommendation row or an orphaned artifact.
 *
 * 3. ALL EIGHT GUARDRAILS BLOCK CORRECTLY: `featureModeAllowedGate` (mode)
 *    plus the seven #77 gates (consent, cooldown, lifecycle-legal,
 *    no-duplicate-task, no-scheduled-activity-conflict, not-terminal-status,
 *    offer-available) plus `noProhibitedGuaranteeGate` — any one of the
 *    latter eight blocking must leave ZERO recommendation rows and no
 *    artifact (see the `FOS1-NBA-0x` per-gate tests below).
 *
 * FLAG (issue #78, mirrors #60/#68/#73 precedent): NO seeded consent,
 * cooldown, offer, or action-type-by-stage registry exists yet.
 * `consentedChannels`, `cooldownUntil`, `existingOpenActions`,
 * `scheduledActivities`, `availableOffers`, and `allowedActionsByStage` are
 * ALL least-privilege, caller-provided input (the run's own Zod-validated
 * input context) — never a live registry/service lookup inside a gate.
 * `allowedActionsByStage` is additionally a DERIVED table: spec §8.6 gives
 * no explicit action-type vocabulary, only "appropriate for the
 * opportunity's current lifecycle stage" — the caller supplies whatever
 * mapping matches its own action-type vocabulary (see
 * `gates/lifecycle-legal.ts`, also generalized to a selector by this issue
 * for the same least-privilege-input reason as consent).
 *
 * FLAG (issue #78, spec §7.1 gap): no dedicated Next-Best-Action artifact
 * type exists in the canonical `artifact_type` enum. `internal_note` (the
 * same closest-fit Phase-0 base member `objection-intelligence.ts` uses) is
 * the stopgap. `domain: "enrollment"` is an exact fit.
 *
 * FLAG (issue #78, spec §6.6 gap): `businessImpact`/`urgency`/`confidence`
 * have no enum in the spec OR in the `enrollment_action_recommendation`
 * table (all modeled as open `text`, issue #70/#71 FLAG). This definition's
 * Zod output schema nonetheless constrains them to DERIVED closed sets
 * (`low`/`medium`/`high`) — the same three-tier vocabulary
 * `enrollment-brief.ts`/`objection-intelligence.ts` already use for
 * `confidence`/`severity` — so the model cannot emit an arbitrary string for
 * a field the founder-facing artifact renders as a fixed-vocabulary badge.
 * The DB column itself stays open `text` (issue #70's own decision, out of
 * this slice's scope to change).
 */

// ---- Input (stage 1/3): least-privilege context the agent reasons over ---

export const NBA_ACTION_TYPES = [
  "send_follow_up_email",
  "send_follow_up_sms",
  "schedule_conversation",
  "propose_offer",
  "internal_task",
  "no_action",
] as const;

const actionKeySchema = z.object({
  type: z.string().min(1),
  target: z.string().min(1),
});

export const nextBestActionInputSchema = z.object({
  opportunity: z.object({
    id: z.string().uuid(),
    stage: z.enum(OPPORTUNITY_STAGES),
    primaryGoal: z.string().optional(),
    targetRole: z.string().optional(),
    targetTimeline: z.string().optional(),
  }),
  person: z.object({
    id: z.string().uuid(),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    currentRole: z.string().optional(),
    currentCompany: z.string().optional(),
    location: z.string().optional(),
  }),
  /** OPTION B allowlist (FOUNDER DECISION, issue #78): channels for which
   * consent has been AFFIRMATIVELY recorded. FLAG: consent registry not
   * seeded — least-privilege caller-provided input (see file header). */
  consentedChannels: z.array(z.string().min(1)),
  /** ISO-8601 "now" reference — the cooldown gate never calls
   * `Date.now()`/`new Date()` itself; the caller supplies it. */
  now: z.string().min(1),
  /** ISO-8601 timestamp before which a contact action is blocked, or `null`
   * if no cooldown is currently in effect. FLAG: cooldown policy/timing is
   * not looked up live — least-privilege caller-provided input. */
  cooldownUntil: z.string().nullable(),
  /** Existing OPEN recommendations/tasks — for `noDuplicateTaskGate`. */
  existingOpenActions: z.array(actionKeySchema),
  /** Scheduled FUTURE activities — for `noScheduledActivityConflictGate`. */
  scheduledActivities: z.array(actionKeySchema),
  /** FLAG: offer registry not seeded — least-privilege caller-provided
   * currently-available offer/pathway set, for `offerAvailableGate`. */
  availableOffers: z.array(z.string().min(1)),
  /** FLAG: DERIVED action-type/stage-legality table — spec §8.6 gives no
   * explicit action-type vocabulary (see file header). Caller-provided,
   * least-privilege input for `lifecycleLegalGate`. Stages absent from this
   * record permit no non-stage-move action (mirrors the gate's own
   * `?? []` fallback). */
  allowedActionsByStage: z.record(z.enum(OPPORTUNITY_STAGES), z.array(z.string().min(1))),
});

export type NextBestActionInput = z.infer<typeof nextBestActionInputSchema>;

// ---- Output (stage 6): the recommended action, EnrollmentActionRecommendation-shaped ----

export const NBA_BUSINESS_IMPACT_VALUES = ["low", "medium", "high"] as const;
export const NBA_URGENCY_VALUES = ["low", "medium", "high"] as const;
export const NBA_CONFIDENCE_VALUES = ["low", "medium", "high"] as const;
/** Sentinel `offer` value meaning "no offer/pathway is implicated by this
 * recommendation" — never a fabricated guess, mirrors
 * `ENROLLMENT_BRIEF_UNDETERMINED_PATHWAY`. */
export const NBA_UNDETERMINED_OFFER = "undetermined";

export const nextBestActionOutputSchema = z.object({
  actionType: z.enum(NBA_ACTION_TYPES),
  /** The action's target identity (e.g. the person id) — matched by the
   * duplicate/conflict gates alongside `actionType`. */
  actionTarget: z.string().min(1),
  /** The channel a CONTACT action would use (e.g. "email", "sms").
   * Undefined/absent for a non-contact action (e.g. `internal_task`) —
   * always allowed by `consentGate`/`cooldownGate`. */
  channel: z.string().optional(),
  /** Whether this proposed action contacts the person at all — subject to
   * `cooldownGate`. Structurally independent of `channel` so a contact
   * action can be flagged even before a channel is chosen. */
  isContact: z.boolean(),
  /** If this action implies moving the opportunity to a specific stage
   * (e.g. proposing an offer implies `offered`), the target stage;
   * otherwise absent and the action is checked against
   * `allowedActionsByStage` instead. */
  impliedStage: z.enum(OPPORTUNITY_STAGES).optional(),
  /** The offer/pathway this recommendation references, or the
   * `NBA_UNDETERMINED_OFFER` sentinel. */
  offer: z.string().min(1),
  summary: z.string().min(1),
  rationale: z.string().min(1),
  businessImpact: z.enum(NBA_BUSINESS_IMPACT_VALUES),
  urgency: z.enum(NBA_URGENCY_VALUES),
  confidence: z.enum(NBA_CONFIDENCE_VALUES),
  /** ISO-8601 timestamp, or absent if no specific due date is recommended. */
  recommendedDueAt: z.string().optional(),
});

export type NextBestActionOutput = z.infer<typeof nextBestActionOutputSchema>;

// ---- Definition ------------------------------------------------------------

export const FOS_NEXT_BEST_ACTION_AGENT_KEY = "fos.next_best_action";
export const FOS_NEXT_BEST_ACTION_FEATURE_FLAG_KEY = "fos.next_best_action";

function selectProposedAction(output: NextBestActionOutput): ActionKey {
  return { type: output.actionType, target: output.actionTarget };
}

export const fosNextBestActionAgentDefinition: AgentDefinition<
  NextBestActionInput,
  NextBestActionOutput
> = {
  key: FOS_NEXT_BEST_ACTION_AGENT_KEY,
  version: "1.0.0",
  objective:
    "Recommend exactly one valid next action for this enrollment opportunity, appropriate for " +
    "its current lifecycle stage, and ONLY after every deterministic guardrail — consent, " +
    "cooldown, lifecycle legality, duplicate tasks, scheduled-activity conflicts, terminal " +
    "status, and offer availability — would pass. Never propose contacting the person on a " +
    "channel without affirmatively recorded consent, and never guarantee an employment, " +
    "recruiter, salary, or interview outcome.",
  inputSchema: nextBestActionInputSchema,
  outputSchema: nextBestActionOutputSchema,
  permittedTools: [],
  permittedMemoryScopes: ["enrollment_opportunity", "person"],
  autonomyCeiling: "review",
  featureFlagKey: FOS_NEXT_BEST_ACTION_FEATURE_FLAG_KEY,
  deterministicGates: [
    featureModeAllowedGate({
      key: "fos.next_best_action.mode-allowed",
      allowedModes: ["shadow", "review"],
    }),
    // FOUNDER DECISION (issue #78): option B, fail-closed allowlist — see
    // gates/consent.ts and the file header above.
    consentGate<NextBestActionInput, NextBestActionOutput>({
      key: "fos.next_best_action.consent",
      selectProposedActionChannel: (output) => output.channel,
      selectConsentedChannels: (input) => input.consentedChannels,
    }),
    cooldownGate<NextBestActionInput, NextBestActionOutput>({
      key: "fos.next_best_action.cooldown",
      selectIsContactAction: (output) => output.isContact,
      selectNow: (input) => input.now,
      selectCooldownUntil: (input) => input.cooldownUntil,
    }),
    lifecycleLegalGate<NextBestActionInput, NextBestActionOutput>({
      key: "fos.next_best_action.lifecycle-legal",
      selectCurrentStage: (input) => input.opportunity.stage,
      selectProposedActionType: (output) => output.actionType,
      selectImpliedStage: (output) => output.impliedStage,
      selectAllowedActionsByStage: (input) =>
        input.allowedActionsByStage as Readonly<Record<OpportunityStage, readonly string[]>>,
    }),
    noDuplicateTaskGate<NextBestActionInput, NextBestActionOutput>({
      key: "fos.next_best_action.no-duplicate-task",
      selectProposedAction: selectProposedAction,
      selectExistingOpenActions: (input) => input.existingOpenActions,
    }),
    noScheduledActivityConflictGate<NextBestActionInput, NextBestActionOutput>({
      key: "fos.next_best_action.no-scheduled-activity-conflict",
      selectProposedAction: selectProposedAction,
      selectScheduledActivities: (input) => input.scheduledActivities,
    }),
    notTerminalStatusGate<NextBestActionInput, NextBestActionOutput>({
      key: "fos.next_best_action.not-terminal-status",
      selectCurrentStage: (input) => input.opportunity.stage,
    }),
    offerAvailableGate<NextBestActionInput, NextBestActionOutput>({
      key: "fos.next_best_action.offer-available",
      selectProposedOffer: (output) => output.offer,
      selectAvailableOffers: (input) => input.availableOffers,
      undeterminedValue: NBA_UNDETERMINED_OFFER,
    }),
    noProhibitedGuaranteeGate<NextBestActionInput, NextBestActionOutput>({
      key: "fos.next_best_action.no-prohibited-guarantee",
      // Keep in sync with `buildBodyMarkdown` below: `summary` and
      // `rationale` are the ONLY free-text fields this output carries.
      // Every other field (`actionType`, `channel`, `offer`,
      // `businessImpact`, `urgency`, `confidence`, `impliedStage`) is a
      // closed-set enum or a gate-validated identifier — none of them is
      // model-authored free text a guarantee could be smuggled into.
      selectText: (output) => [output.summary, output.rationale],
    }),
  ],
  artifact: {
    // FLAG: spec §7.1 has no dedicated Next-Best-Action artifact type — see
    // file header. `internal_note` mirrors `objection-intelligence.ts`'s
    // stopgap.
    artifactType: "internal_note",
    domain: "enrollment",
    buildTitle: (input) => `Next Best Action: ${input.person.firstName} ${input.person.lastName}`,
    buildBodyMarkdown: (input, output) =>
      [
        `# Next Best Action: ${input.person.firstName} ${input.person.lastName}`,
        "",
        `**Recommended action:** ${output.actionType}${output.channel ? ` (${output.channel})` : ""}`,
        `**Offer:** ${output.offer}`,
        `**Business impact:** ${output.businessImpact} | **Urgency:** ${output.urgency} | **Confidence:** ${output.confidence}`,
        ...(output.recommendedDueAt ? [`**Recommended due:** ${output.recommendedDueAt}`] : []),
        "",
        "## Summary",
        output.summary,
        "",
        "## Rationale",
        output.rationale,
      ].join("\n"),
    buildClaimsManifest: (_input, output) => ({
      // Internal audit aid: the exact action identity this run recommended.
      actionType: output.actionType,
      actionTarget: output.actionTarget,
      isContact: output.isContact,
    }),
  },
  // Stage 9b (canonical, atomic — issue #78's hard property #2): writes
  // exactly ONE EnrollmentActionRecommendation via `createActionRecommendation`
  // (issue #71), INSIDE the stage-9 transaction the runtime already opens
  // (`ctx.deps.db` here is a tx handle — see PersistDomainHookContext /
  // issue #63). Ownership assertion FIRST: a throw here (or in
  // `createActionRecommendation`) rolls back the artifact/version/event
  // `createArtifact` wrote just before it — never an orphaned recommendation
  // row or an orphaned artifact.
  persistDomain: async ({ deps, runContext, agentRunId }, input, output, artifactResult) => {
    const opportunityRow = await loadOwnedOpportunity(
      deps.db,
      input.opportunity.id,
      runContext.workspaceId,
    );

    await createActionRecommendation(deps.db, {
      workspaceId: runContext.workspaceId,
      opportunityId: opportunityRow.id,
      agentRunId,
      actionType: output.actionType,
      summary: output.summary,
      rationale: output.rationale,
      businessImpact: output.businessImpact,
      urgency: output.urgency,
      confidence: output.confidence,
      recommendedDueAt: output.recommendedDueAt ? new Date(output.recommendedDueAt) : null,
      artifactRecordId: artifactResult.artifactId,
    });
  },
  // No `projection` hook (spec boundary, issue #78): no API wiring, no
  // worker/stalled-opportunity job (P1.4e), no Follow-Up agent (P1.4d) —
  // those are later P1.4 sub-slices.
};
