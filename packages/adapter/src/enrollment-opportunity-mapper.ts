import type { enrollmentOpportunity, projectionSyncStatusEnum } from "@fos/db/schema";

export type EnrollmentOpportunityRow = typeof enrollmentOpportunity.$inferSelect;
export type ProjectionSyncStatus = (typeof projectionSyncStatusEnum.enumValues)[number];

export interface EnrollmentOpportunityProjectionContext {
  workspaceId: string;
  productId: string | null;
  syncStatus: ProjectionSyncStatus;
  /** The instant this projection write is happening — not the entity's own timestamps. */
  lastSyncedAt: Date;
}

function richText(content: string | null) {
  return { rich_text: content === null ? [] : [{ text: { content } }] };
}

/**
 * Notion `number` property. `null` is a VALID value (`{ number: null }` clears
 * the property) — do NOT wrap it in an object. Keeps the mapper pure.
 */
function numberProp(value: number | null) {
  return { number: value };
}

/**
 * Notion `date` property. Per the Notion API, an unset date is `{ date: null }`
 * — NOT `{ date: { start: null } }`, which is rejected. A populated date is
 * serialized ISO-8601 (UTC) so the projection is deterministic from its input.
 */
function dateProp(value: Date | null) {
  return { date: value === null ? null : { start: value.toISOString() } };
}

/**
 * Value in major currency units (cents / 100) as a Notion `number`. See the
 * cents-vs-major-unit decision in the mapper doc-comment below. `null` stays
 * `{ number: null }` (property cleared).
 */
function majorUnitProp(cents: number | null) {
  return { number: cents === null ? null : cents / 100 };
}

/**
 * Pure mapper: EnrollmentOpportunity (§9.4) -> Notion page-properties object.
 *
 * Emits all 7 PATCH-SET-01 §C1 hidden properties (FOS Version per §C2: for a
 * versioned entity, `FOS Version = entity.version`) plus the visible §7.2
 * Enrollment Pipeline fields sourced from the opportunity row's OWN columns
 * (P1.5a, issue #86): summary, stage, fit, value, last interaction, next
 * action, and the canonical link. The two join-requiring §7.2 fields —
 * `objections` and `pending artifact` — are DEFERRED to P1.5b (they need DB
 * joins this minimal mapper signature does not have).
 *
 * VALUE UNITS: `estimated_value_cents` / `actual_value_cents` are stored as
 * integer cents but projected as MAJOR CURRENCY UNITS (cents / 100) under the
 * "Estimated Value" / "Actual Value" properties — a founder reads a pipeline
 * in dollars, not cents. The unit's currency is surfaced by the adjacent
 * "Currency" property (`enrollment_opportunity.currency`, non-null, default
 * USD), so the value + currency pair is unambiguous without hard-coding a
 * currency into the property name.
 *
 * CANONICAL LINK: "Canonical Link" surfaces the FOS record id. A real
 * deep-link URL awaits the P1.9 dashboard; until then the record id IS the
 * canonical reference (and mirrors the hidden "FOS Record ID" for humans).
 *
 * NULL HANDLING: most §7.2 columns are nullable. `richText(null)` yields an
 * empty array; `numberProp(null)` -> `{ number: null }`; `dateProp(null)` ->
 * `{ date: null }`. `fit_status`, `next_action_type`, `last_touch_source`,
 * and `recommended_pathway` are OPEN TEXT per the schema comments (no spec
 * enum), so they project as rich_text, never as an invented `select`.
 *
 * No title-type property is set: §13.2's Enrollment Pipeline template implies
 * a person-name title column, but that requires a Person join this slice's
 * minimal mapper signature (opp + workspace/product ids) does not have. FLAG
 * (PATCH-SET candidate): add a title-bearing field once a Person-joined
 * projection exists — until then, created pages have an empty Notion-native
 * title (allowed by the API; not a broken page, just untitled in the UI).
 */
export function enrollmentOpportunityToNotionProperties(
  opp: EnrollmentOpportunityRow,
  ctx: EnrollmentOpportunityProjectionContext,
): Record<string, unknown> {
  return {
    // --- §C1 hidden-property contract (all 7, exact names) ---
    "FOS Record ID": richText(opp.id),
    "FOS Entity Type": richText("EnrollmentOpportunity"),
    "FOS Workspace ID": richText(ctx.workspaceId),
    "FOS Product ID": richText(ctx.productId),
    "Sync Status": { select: { name: ctx.syncStatus } },
    // §C2: versioned entity -> FOS Version = entity.version.
    "FOS Version": { number: opp.version },
    "Last Synced At": { date: { start: ctx.lastSyncedAt.toISOString() } },

    // --- §7.2 visible fields (P1.5a; opportunity-owned columns only) ---
    Stage: { select: { name: opp.stage } },

    // Summary
    Summary: richText(opp.fitSummary),
    "Primary Goal": richText(opp.primaryGoal),
    "Target Role": richText(opp.targetRole),
    "Target Timeline": richText(opp.targetTimeline),

    // Fit
    "Fit Status": richText(opp.fitStatus),
    "Fit Score": numberProp(opp.fitScore),

    // Value (major units; see doc-comment)
    "Estimated Value": majorUnitProp(opp.estimatedValueCents),
    "Actual Value": majorUnitProp(opp.actualValueCents),
    Currency: { select: { name: opp.currency } },

    // Last interaction
    "Last Interaction At": dateProp(opp.lastInteractionAt),
    "Last Touch Source": richText(opp.lastTouchSource),

    // Next action
    "Next Action": richText(opp.nextActionSummary),
    "Next Action Type": richText(opp.nextActionType),
    "Next Action Due At": dateProp(opp.nextActionDueAt),
    "Recommended Pathway": richText(opp.recommendedPathway),

    // Canonical link (record id until the P1.9 dashboard ships deep links)
    "Canonical Link": richText(opp.id),
  };
}

/**
 * §8.2/§11.3 ProjectionPolicy for the fields this slice projects. Every field
 * is `canonical_read_only`: P1.5a writes FOS->Notion only; nothing here lets a
 * Notion edit flow back (that's the reconciliation + command-intake slices,
 * 0.2c/0.2d). The P1.5a §7.2 columns are listed alongside the pre-existing
 * id/version/stage entries; the deferred join fields (objections, pending
 * artifact — P1.5b) are intentionally absent.
 */
export const enrollmentOpportunityProjectionPolicy = {
  entity_type: "EnrollmentOpportunity",
  provider: "notion",
  fields: {
    id: "canonical_read_only",
    version: "canonical_read_only",
    stage: "canonical_read_only",
    fitSummary: "canonical_read_only",
    primaryGoal: "canonical_read_only",
    targetRole: "canonical_read_only",
    targetTimeline: "canonical_read_only",
    fitStatus: "canonical_read_only",
    fitScore: "canonical_read_only",
    estimatedValueCents: "canonical_read_only",
    actualValueCents: "canonical_read_only",
    currency: "canonical_read_only",
    lastInteractionAt: "canonical_read_only",
    lastTouchSource: "canonical_read_only",
    nextActionSummary: "canonical_read_only",
    nextActionType: "canonical_read_only",
    nextActionDueAt: "canonical_read_only",
    recommendedPathway: "canonical_read_only",
  },
  redaction_rules: [],
  maximum_sensitivity: "internal",
  requires_founder_approval: false,
} as const;
