import { randomUUID } from "node:crypto";
import { product, person, enrollmentOpportunity } from "@fos/db/schema";
import { createInteraction } from "@fos/db/services";
import {
  createEvalDb,
  seedEvalWorkspace,
  setEvalFeatureFlag,
  seedEnrollmentBriefFixture as seedEnrollmentBriefFixtureImpl,
  type EvalDb,
} from "../testing/eval-harness.js";

/** Re-exported from ../testing/eval-harness.ts, which is importable outside
 * __tests__/ so `scripts/eval-run.ts` can use the same substrate (P1.10a).
 * The names here are unchanged so the eleven existing agent test files that
 * import from this module keep working untouched. */
export const createTestDb = createEvalDb;
export const seedWorkspace = seedEvalWorkspace;
export const setFeatureFlag = setEvalFeatureFlag;
export const seedEnrollmentBriefFixture = seedEnrollmentBriefFixtureImpl;

/**
 * Seeds an EnrollmentOpportunity + Person chain plus a scheduled Interaction
 * (P1.3a substrate) for the `fos.call_preparation` agent tests (issue #60),
 * which need real canonical rows to assert workspace ownership against at
 * the persistDomain seam (no domain record is written by this agent).
 *
 * Accepts an optional already-seeded `workspace` row so a test can seed a
 * SECOND opportunity/interaction chain inside the SAME workspace (e.g. to
 * exercise the "interaction belongs to a different opportunity" check,
 * distinct from the cross-workspace check).
 */
export async function seedCallPreparationFixture(
  db: EvalDb,
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const workspace = existingWorkspace ?? (await seedWorkspace(db));

  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      // Suffix with a fresh id: `existingWorkspace` lets a test seed a
      // SECOND opportunity chain in the same workspace, and
      // (workspace_id, product_key) is unique.
      productKey: `career-foundry-${randomUUID().slice(0, 8)}`,
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();
  if (!prod) throw new Error("seedCallPreparationFixture: product insert returned no row");

  const [personRow] = await db
    .insert(person)
    .values({
      workspaceId: workspace.id,
      firstName: "Ada",
      lastName: "Lovelace",
      currentRole: "Data Analyst",
      currentCompany: "Acme Corp",
      location: "Remote",
      source: "website_application",
      lifecycleType: "applicant",
    })
    .returning();
  if (!personRow) throw new Error("seedCallPreparationFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "conversation_scheduled",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedCallPreparationFixture: enrollment_opportunity insert returned no row");

  const interactionRow = await createInteraction(db, {
    workspaceId: workspace.id,
    opportunityId: opportunity.id,
    interactionType: "discovery_call",
    status: "scheduled",
    scheduledAt: new Date("2026-07-25T15:00:00.000Z"),
  });

  return { workspace, product: prod, person: personRow, opportunity, interaction: interactionRow };
}

/**
 * Seeds an EnrollmentOpportunity + Person chain plus a COMPLETED Interaction
 * (P1.3a substrate) for the `fos.post_call_synthesis` agent tests (issue
 * #68) — mirrors `seedCallPreparationFixture` exactly, but the opportunity
 * starts at `conversation_scheduled` (a stage with legal outgoing edges to
 * `conversation_completed`, `contacted`, and `unresponsive` per the §12.1
 * matrix, so a test can freely exercise both legal and illegal proposed
 * stages) and the interaction is `completed` (the call already happened).
 *
 * Accepts an optional already-seeded `workspace` row for the same reason as
 * `seedCallPreparationFixture`: exercising the
 * "interaction belongs to a different opportunity" check.
 */
export async function seedPostCallSynthesisFixture(
  db: EvalDb,
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const workspace = existingWorkspace ?? (await seedWorkspace(db));

  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: `career-foundry-${randomUUID().slice(0, 8)}`,
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();
  if (!prod) throw new Error("seedPostCallSynthesisFixture: product insert returned no row");

  const [personRow] = await db
    .insert(person)
    .values({
      workspaceId: workspace.id,
      firstName: "Ada",
      lastName: "Lovelace",
      currentRole: "Data Analyst",
      currentCompany: "Acme Corp",
      location: "Remote",
      source: "website_application",
      lifecycleType: "applicant",
    })
    .returning();
  if (!personRow) throw new Error("seedPostCallSynthesisFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "conversation_scheduled",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedPostCallSynthesisFixture: enrollment_opportunity insert returned no row");

  const interactionRow = await createInteraction(db, {
    workspaceId: workspace.id,
    opportunityId: opportunity.id,
    interactionType: "discovery_call",
    status: "completed",
    scheduledAt: new Date("2026-07-25T15:00:00.000Z"),
    occurredAt: new Date("2026-07-25T15:32:00.000Z"),
  });

  return { workspace, product: prod, person: personRow, opportunity, interaction: interactionRow };
}

/**
 * Seeds an EnrollmentOpportunity + Person chain plus a COMPLETED Interaction
 * for the `fos.objection_intelligence` agent tests (issue #73) — mirrors
 * `seedPostCallSynthesisFixture` exactly, since both agents run on the same
 * completed-conversation substrate (spec §9.2 step 4).
 *
 * Accepts an optional already-seeded `workspace` row for the same reason as
 * `seedPostCallSynthesisFixture`: exercising the
 * "interaction belongs to a different opportunity" check.
 */
export async function seedObjectionIntelligenceFixture(
  db: EvalDb,
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const workspace = existingWorkspace ?? (await seedWorkspace(db));

  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: `career-foundry-${randomUUID().slice(0, 8)}`,
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();
  if (!prod) throw new Error("seedObjectionIntelligenceFixture: product insert returned no row");

  const [personRow] = await db
    .insert(person)
    .values({
      workspaceId: workspace.id,
      firstName: "Ada",
      lastName: "Lovelace",
      currentRole: "Data Analyst",
      currentCompany: "Acme Corp",
      location: "Remote",
      source: "website_application",
      lifecycleType: "applicant",
    })
    .returning();
  if (!personRow)
    throw new Error("seedObjectionIntelligenceFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "conversation_scheduled",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error(
      "seedObjectionIntelligenceFixture: enrollment_opportunity insert returned no row",
    );

  const interactionRow = await createInteraction(db, {
    workspaceId: workspace.id,
    opportunityId: opportunity.id,
    interactionType: "discovery_call",
    status: "completed",
    scheduledAt: new Date("2026-07-25T15:00:00.000Z"),
    occurredAt: new Date("2026-07-25T15:32:00.000Z"),
  });

  return { workspace, product: prod, person: personRow, opportunity, interaction: interactionRow };
}

/**
 * Seeds an EnrollmentOpportunity + Person chain for the
 * `fos.next_best_action` agent tests (issue #78) — no Interaction is needed
 * (unlike `seedObjectionIntelligenceFixture`/`seedPostCallSynthesisFixture`):
 * this agent's ownership assertion is opportunity-only (see
 * `loadOwnedOpportunity` in `definitions/next-best-action.ts`). Defaults the
 * opportunity to `contacted` — a non-terminal stage with legal outgoing
 * edges, so a test can freely exercise both legal and illegal proposed
 * stages/action types.
 *
 * Accepts an optional already-seeded `workspace` row for the same reason as
 * the other fixtures: exercising the cross-workspace ownership check.
 */
export async function seedNextBestActionFixture(
  db: EvalDb,
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const workspace = existingWorkspace ?? (await seedWorkspace(db));

  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: `career-foundry-${randomUUID().slice(0, 8)}`,
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();
  if (!prod) throw new Error("seedNextBestActionFixture: product insert returned no row");

  const [personRow] = await db
    .insert(person)
    .values({
      workspaceId: workspace.id,
      firstName: "Ada",
      lastName: "Lovelace",
      currentRole: "Data Analyst",
      currentCompany: "Acme Corp",
      location: "Remote",
      source: "website_application",
      lifecycleType: "applicant",
    })
    .returning();
  if (!personRow) throw new Error("seedNextBestActionFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "contacted",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedNextBestActionFixture: enrollment_opportunity insert returned no row");

  return { workspace, product: prod, person: personRow, opportunity };
}

/**
 * Seeds an EnrollmentOpportunity + Person chain for the
 * `fos.personalized_follow_up` agent tests (issue #82) — no Interaction is
 * needed: like `fos.next_best_action`, this agent's ownership assertion is
 * opportunity-only (see `loadOwnedOpportunity` in
 * `definitions/personalized-follow-up.ts`). Defaults the opportunity to
 * `contacted` (a non-terminal stage) — mirrors `seedNextBestActionFixture`.
 *
 * Accepts an optional already-seeded `workspace` row for the same reason as
 * the other fixtures: exercising the cross-workspace ownership check.
 */
export async function seedPersonalizedFollowUpFixture(
  db: EvalDb,
  existingWorkspace?: Awaited<ReturnType<typeof seedWorkspace>>,
) {
  const workspace = existingWorkspace ?? (await seedWorkspace(db));

  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: `career-foundry-${randomUUID().slice(0, 8)}`,
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();
  if (!prod) throw new Error("seedPersonalizedFollowUpFixture: product insert returned no row");

  const [personRow] = await db
    .insert(person)
    .values({
      workspaceId: workspace.id,
      firstName: "Ada",
      lastName: "Lovelace",
      currentRole: "Data Analyst",
      currentCompany: "Acme Corp",
      location: "Remote",
      source: "website_application",
      lifecycleType: "applicant",
    })
    .returning();
  if (!personRow) throw new Error("seedPersonalizedFollowUpFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "contacted",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error(
      "seedPersonalizedFollowUpFixture: enrollment_opportunity insert returned no row",
    );

  return { workspace, product: prod, person: personRow, opportunity };
}
