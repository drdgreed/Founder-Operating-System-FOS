import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@fos/db/schema";
import {
  fosWorkspace,
  product,
  person,
  enrollmentOpportunity,
  campaign,
  campaignTouch,
  operationalEvent,
  agentRun,
  interaction,
} from "@fos/db/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/api/test -> repo root -> packages/db/migrations
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "..", "packages", "db", "migrations");

/** Hermetic in-process Postgres (PGlite) with all migrations applied. */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, client, close: () => client.close() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedWorkspaceAndProduct(db: any, tag = "a") {
  const [workspace] = await db
    .insert(fosWorkspace)
    .values({ name: `ws-${tag}`, ownerUserId: "founder-1" })
    .returning();
  const [prod] = await db
    .insert(product)
    .values({
      workspaceId: workspace.id,
      productKey: `product-${tag}`,
      name: `Product ${tag}`,
      productType: "product",
      parentProductId: null,
    })
    .returning();
  return { workspace, product: prod };
}

// ─── Dashboard (P1.9) seed helpers ───────────────────────────────────────────
// Minimal, tenant-parameterized inserts so a test can build two workspaces and
// assert isolation. Every helper takes an explicit workspaceId (never a global
// default) precisely so a cross-workspace leak is expressible in a test.

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function seedPerson(db: any, workspaceId: string) {
  const [row] = await db
    .insert(person)
    .values({
      workspaceId,
      firstName: "Test",
      lastName: "Person",
      source: "manual",
      lifecycleType: "applicant",
    })
    .returning();
  return row;
}

export async function seedOpportunity(
  db: any,
  opts: {
    workspaceId: string;
    productId: string;
    personId: string;
    stage: string;
    campaignId?: string;
  },
) {
  const [row] = await db
    .insert(enrollmentOpportunity)
    .values({
      workspaceId: opts.workspaceId,
      productId: opts.productId,
      personId: opts.personId,
      stage: opts.stage as any,
      currency: "USD",
      version: 1,
      campaignId: opts.campaignId ?? null,
    })
    .returning();
  return row;
}

export async function seedCampaign(
  db: any,
  opts: { workspaceId: string; productId: string; key: string },
) {
  const [row] = await db
    .insert(campaign)
    .values({
      workspaceId: opts.workspaceId,
      productId: opts.productId,
      campaignKey: opts.key,
      name: `Campaign ${opts.key}`,
    })
    .returning();
  return row;
}

export async function seedCampaignTouch(
  db: any,
  opts: { campaignId: string; opportunityId?: string },
) {
  const [row] = await db
    .insert(campaignTouch)
    .values({
      campaignId: opts.campaignId,
      opportunityId: opts.opportunityId ?? null,
    })
    .returning();
  return row;
}

export async function seedOperationalEvent(db: any, workspaceId: string, occurredAt: Date) {
  const [row] = await db
    .insert(operationalEvent)
    .values({
      workspaceId,
      entityType: "enrollment_opportunity",
      entityId: randomUUID(),
      source: "test",
      correlationId: randomUUID(),
      occurredAt,
      actorType: "system",
      actorId: "service-account",
      type: "opportunity.created",
      payload: {},
    })
    .returning();
  return row;
}

export async function seedAgentRun(db: any, workspaceId: string, createdAt?: Date) {
  const [row] = await db
    .insert(agentRun)
    .values({
      workspaceId,
      agentKey: "test-agent",
      agentVersion: "v1",
      promptVersion: "v1",
      trigger: "manual",
      actorJson: { type: "system", id: "service-account" },
      featureMode: "live",
      contextManifestJson: {},
      correlationId: randomUUID(),
      ...(createdAt ? { createdAt } : {}),
    })
    .returning();
  return row;
}

export async function seedInteraction(
  db: any,
  opts: { workspaceId: string; opportunityId: string; createdAt?: Date },
) {
  const [row] = await db
    .insert(interaction)
    .values({
      workspaceId: opts.workspaceId,
      opportunityId: opts.opportunityId,
      interactionType: "conversation",
      status: "scheduled",
      version: 1,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning();
  return row;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
