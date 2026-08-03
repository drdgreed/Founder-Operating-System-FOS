import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@fos/db/schema";
import {
  fosWorkspace,
  featureFlag,
  product,
  person,
  enrollmentOpportunity,
  applicationSubmission,
  type FeatureFlagMode,
  interaction,
} from "@fos/db/schema";
import type { OpportunityStage } from "@fos/db/services";
import { NotionClient } from "@fos/notion";
import type { ComplianceReviewDecision } from "../types.js";

/**
 * The eval harness (design §2 D4, plan §A2). Everything a live-model eval run
 * needs in order to touch NOTHING outside its own process:
 *
 *  - an in-process Postgres (PGlite) with every migration applied, discarded
 *    when the run ends — the founder's canonical database is never opened;
 *  - a stub NotionClient whose fetch never reaches the network, so a run
 *    holding a real Notion token still cannot write a real page;
 *  - a stub compliance reviewer, so stage 7b costs nothing in dry-run mode.
 *
 * This module lives OUTSIDE `__tests__/` because `scripts/eval-run.ts` needs
 * it and `__tests__/` is not an importable surface.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/agents/src/testing -> packages/db/migrations
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "..", "db", "migrations");

export async function createEvalDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, close: () => client.close() };
}

export type EvalDb = Awaited<ReturnType<typeof createEvalDb>>["db"];

export async function seedEvalWorkspace(db: EvalDb) {
  const [workspace] = await db
    .insert(fosWorkspace)
    .values({ name: "Test Workspace", ownerUserId: "founder-1" })
    .returning();
  if (!workspace) throw new Error("seedEvalWorkspace: fos_workspace insert returned no row");
  return workspace;
}

export async function setEvalFeatureFlag(
  db: EvalDb,
  input: { workspaceId: string; key: string; enabled: boolean; mode: FeatureFlagMode },
) {
  const [row] = await db
    .insert(featureFlag)
    .values({
      workspaceId: input.workspaceId,
      key: input.key,
      enabled: input.enabled,
      mode: input.mode,
    })
    .onConflictDoUpdate({
      target: [featureFlag.workspaceId, featureFlag.key],
      set: { enabled: input.enabled, mode: input.mode, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("setEvalFeatureFlag: feature_flag upsert returned no row");
  return row;
}

export async function seedEnrollmentBriefFixture(db: EvalDb) {
  const workspace = await seedEvalWorkspace(db);

  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: "career-foundry",
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();
  if (!prod) throw new Error("seedEnrollmentBriefFixture: product insert returned no row");

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
  if (!personRow) throw new Error("seedEnrollmentBriefFixture: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: "reviewing",
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedEnrollmentBriefFixture: enrollment_opportunity insert returned no row");

  const [application] = await db
    .insert(applicationSubmission)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      opportunityId: opportunity.id,
      formVersion: "v1",
      rawPayloadJson: { note: "seeded fixture" },
      sourceReference: "website_application",
      intakeIdempotencyKey: `seed-${opportunity.id}`,
    })
    .returning();
  if (!application)
    throw new Error("seedEnrollmentBriefFixture: application_submission insert returned no row");

  return { workspace, product: prod, person: personRow, opportunity, application };
}

/**
 * Seed the canonical rows a CONVERSATION-shaped agent reasons over: workspace,
 * product, person, enrollment opportunity, and one `interaction`.
 *
 * Parameterised rather than duplicated because three agents now need exactly
 * this graph and differ only in the interaction's state — `fos.objection_intelligence`
 * classifies objections from a call that HAPPENED, `fos.call_preparation`
 * prepares for one that is SCHEDULED, `fos.post_call_synthesis` recaps one that
 * HAPPENED. A fixture whose interaction is in the wrong state is a fixture that
 * cannot legitimately produce its own output.
 *
 * `opportunityStage` is likewise a parameter, defaulting to the historical
 * `"reviewing"` so the two existing wrappers are byte-identical. It exists for
 * `fos.post_call_synthesis`, whose `stage-proposal-legal` gate reads
 * `input.opportunity.stage` and whose fixtures each declare the stage their
 * expected proposal is legal FROM. The runner rebinds the fixture's stage onto
 * the seeded row, so a hardcoded seed stage would silently rewrite what every
 * one of those fixtures tests.
 *
 * `notes` and `transcriptRef` stay NULL on purpose. They are UNTRUSTED
 * (spec 551) and reach the model only via `evidenceRecords`; seeding content
 * there would imply a path that must not exist.
 *
 * `evidenceRecords` are likewise NOT seeded — they arrive from the fixture as
 * opaque, sourceRef-addressable entries, and there is no Evidence table (a FLAG
 * carried by every agent in this family).
 */
async function seedConversationFixture(
  db: EvalDb,
  interactionValues: { status: string; occurredAt?: Date; scheduledAt?: Date },
  opportunityStage: OpportunityStage = "reviewing",
) {
  const graph = await seedOpportunityGraph(db, opportunityStage);

  const [interactionRow] = await db
    .insert(interaction)
    .values({
      workspaceId: graph.workspace.id,
      opportunityId: graph.opportunity.id,
      interactionType: "discovery_call",
      version: 1,
      ...interactionValues,
    })
    .returning();
  if (!interactionRow)
    throw new Error("seedConversationFixture: interaction insert returned no row");

  return { ...graph, interaction: interactionRow };
}

/**
 * The canonical rows EVERY enrollment-shaped agent reasons over, with NO
 * interaction: workspace, product, person, enrollment opportunity.
 *
 * Extracted from `seedConversationFixture` (a pure extraction — same inserts,
 * same order, same values) for `fos.personalized_follow_up`, whose input schema
 * has no `interaction` field at all. Seeding an interaction row that agent's
 * input cannot reference would imply a relationship the definition does not
 * have; its own unit-test seeder (`__tests__/test-db.ts`) seeds exactly these
 * four rows, and this keeps the eval harness honest to the same shape without
 * duplicating them.
 */
async function seedOpportunityGraph(db: EvalDb, opportunityStage: OpportunityStage = "reviewing") {
  const workspace = await seedEvalWorkspace(db);

  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: "career-foundry",
      name: "Career Foundry",
      productType: "product",
      parentProductId: null,
    })
    .returning();
  if (!prod) throw new Error("seedOpportunityGraph: product insert returned no row");

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
  if (!personRow) throw new Error("seedOpportunityGraph: person insert returned no row");

  const [opportunity] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: workspace.id,
      productId: prod.id,
      personId: personRow.id,
      stage: opportunityStage,
      currency: "USD",
      version: 1,
    })
    .returning();
  if (!opportunity)
    throw new Error("seedOpportunityGraph: enrollment_opportunity insert returned no row");

  return { workspace, product: prod, person: personRow, opportunity };
}

/** `fos.objection_intelligence` classifies objections from a call that HAPPENED. */
export function seedObjectionIntelligenceFixture(db: EvalDb) {
  return seedConversationFixture(db, {
    status: "completed",
    occurredAt: new Date("2026-01-15T15:00:00Z"),
  });
}

/** `fos.call_preparation` prepares for a call that has NOT happened yet. */
export function seedCallPreparationFixture(db: EvalDb) {
  return seedConversationFixture(db, {
    status: "scheduled",
    scheduledAt: new Date("2026-02-01T15:00:00Z"),
  });
}

/**
 * `fos.post_call_synthesis` recaps a call that HAPPENED — same interaction
 * state as objection_intelligence, but the opportunity's stage is supplied by
 * the caller because this agent's `stage-proposal-legal` gate reads it.
 */
export function seedPostCallSynthesisFixture(db: EvalDb, opportunityStage: OpportunityStage) {
  return seedConversationFixture(
    db,
    { status: "completed", occurredAt: new Date("2026-01-15T15:00:00Z") },
    opportunityStage,
  );
}

/**
 * `fos.personalized_follow_up` drafts outbound copy for an opportunity. NO
 * interaction is seeded: unlike the three conversation agents, this agent's
 * input schema has no `interaction` field, so there is nothing for the runner
 * to rebind and no path by which an interaction row could reach the model.
 *
 * The stage is a required parameter rather than defaulted, because every
 * fixture declares the stage its follow-up TYPE only makes sense from (an
 * `offer_follow_up` from `offered`, a `no_show_recovery` from
 * `conversation_scheduled`), and the runner rebinds the seeded stage back onto
 * the input. Defaulting it would silently rewrite that context to `reviewing`
 * for every fixture. Note this is coherence, not a gate: no gate on this agent
 * reads the stage (contrast `fos.post_call_synthesis`, where it is load-bearing).
 */
export function seedPersonalizedFollowUpFixture(db: EvalDb, opportunityStage: OpportunityStage) {
  return seedOpportunityGraph(db, opportunityStage);
}

/** Env var the stub Notion client reads its (irrelevant) token from. Set by
 * `createStubNotionClient` itself so a REAL Notion token env var is never
 * consulted during an eval run (plan §A2). */
export const STUB_NOTION_CREDENTIAL_REFERENCE = "FOS_EVAL_STUB_NOTION_TOKEN";

export interface StubNotionCall {
  method: string;
  path: string;
}

/**
 * A `NotionClient` wired to a fetch that never reaches the network. Stage 11
 * projection therefore exercises the real projection code path while writing
 * nowhere. Returns the recorded calls so a caller can assert a projection was
 * attempted.
 */
export function createStubNotionClient(): { client: NotionClient; calls: StubNotionCall[] } {
  const calls: StubNotionCall[] = [];
  let pageCounter = 0;
  process.env[STUB_NOTION_CREDENTIAL_REFERENCE] = "stub-token-never-used";
  const client = new NotionClient({
    fetchImpl: async (path, init) => {
      const method = init?.method ?? "GET";
      calls.push({ method, path });
      if (method === "POST" && path.endsWith("/pages")) {
        pageCounter += 1;
        return new Response(
          JSON.stringify({ object: "page", id: `stub-notion-page-${pageCounter}` }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "PATCH" && path.includes("/pages/")) {
        return new Response(JSON.stringify({ object: "page", id: path.split("/pages/")[1] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`createStubNotionClient: unexpected call ${method} ${path}`);
    },
    requestsPerSecond: 1000,
    credentialReference: STUB_NOTION_CREDENTIAL_REFERENCE,
  });
  return { client, calls };
}

/**
 * Stage-7b reviewer for DRY-RUN evals: always allows. Dry-run mode exists to
 * prove the harness plumbing, not the classifier — and the classifier is a
 * model call, which dry-run mode must not make. P1.10c replaces this with the
 * pipeline's real default (the two-tier guarantee classifier over the live
 * model client).
 */
export const stubComplianceReviewer = async (_text: string): Promise<ComplianceReviewDecision> => ({
  verdict: "allow",
  reason: "stub reviewer (offline eval): stage 7b is not exercised in dry-run mode",
});
