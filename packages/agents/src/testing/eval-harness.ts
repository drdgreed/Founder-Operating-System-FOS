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
} from "@fos/db/schema";
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
