import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import {
  seedWorkspaceAndProduct,
  seedPerson,
  seedOpportunity,
  seedArtifactWithStatus,
} from "./fixtures.js";
import { campaign } from "../../schema/campaign.js";
import { campaignTouch } from "../../schema/campaign_touch.js";
import { enrollmentOpportunity } from "../../schema/enrollment_opportunity.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

describe("P1.6 Campaign + CampaignTouch migration (issue #91)", () => {
  it("FOS1-CAMP-01: the P1.6 migration applies clean on a fresh DB; both new tables are queryable", async () => {
    const { db, close } = await createTestDb();
    try {
      expect(await db.select().from(campaign)).toEqual([]);
      expect(await db.select().from(campaignTouch)).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("campaign entity (spec §6.2 / PATCH-SET-01 §B2)", () => {
  it("FOS1-CAMP-02: a campaign row inserts with a product and reads back with defaults (status=draft, id-arrays=[], success_metrics={}, offer/budget null)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);

      const [inserted] = await ctx.db
        .insert(campaign)
        .values({
          workspaceId: workspace.id,
          productId: product.id,
          campaignKey: "beta-launch-2026",
          name: "Beta Launch 2026",
        })
        .returning();
      if (!inserted) throw new Error("campaign insert returned no row");

      expect(inserted.status).toBe("draft");
      expect(inserted.audienceSegmentIds).toEqual([]);
      expect(inserted.narrativeIds).toEqual([]);
      expect(inserted.contentPillarIds).toEqual([]);
      expect(inserted.channelIds).toEqual([]);
      expect(inserted.secondaryCtaIds).toEqual([]);
      expect(inserted.successMetricsJson).toEqual({});
      expect(inserted.offerId).toBeNull();
      expect(inserted.primaryCtaId).toBeNull();
      expect(inserted.budgetAmount).toBeNull();
      // §C2: unversioned — there is no `version` field on the row at all.
      expect("version" in inserted).toBe(false);

      const [reread] = await ctx.db.select().from(campaign).where(eq(campaign.id, inserted.id));
      expect(reread).toMatchObject({
        workspaceId: workspace.id,
        productId: product.id,
        campaignKey: "beta-launch-2026",
        name: "Beta Launch 2026",
        status: "draft",
      });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-CAMP-03: product_id and workspace_id are required FKs — bogus values are rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);

      // Bogus product_id.
      await expect(
        ctx.db.insert(campaign).values({
          workspaceId: workspace.id,
          productId: NIL_UUID,
          campaignKey: "k1",
          name: "n1",
        }),
      ).rejects.toThrow();

      // Bogus workspace_id.
      await expect(
        ctx.db.insert(campaign).values({
          workspaceId: NIL_UUID,
          productId: product.id,
          campaignKey: "k2",
          name: "n2",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-CAMP-04: the status CHECK is enforced — an unregistered status value is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
      await expect(
        ctx.db.insert(campaign).values({
          workspaceId: workspace.id,
          productId: product.id,
          campaignKey: "k3",
          name: "n3",
          status: "not_a_real_status",
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});

describe("campaign_touch entity (spec §6.3 / PATCH-SET-01 §D2, append-only)", () => {
  it("FOS1-CAMP-05: a campaign_touch inserts with campaign + artifact and reads back (utm defaults to {}); campaign_id is a required FK; artifact_record_id nullable FK holds", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
      const [camp] = await ctx.db
        .insert(campaign)
        .values({ workspaceId: workspace.id, productId: product.id, campaignKey: "c", name: "C" })
        .returning();
      if (!camp) throw new Error("campaign insert returned no row");
      const { record: artifact } = await seedArtifactWithStatus(ctx.db, {
        workspaceId: workspace.id,
        productId: product.id,
        status: "draft",
      });

      const [touch] = await ctx.db
        .insert(campaignTouch)
        .values({
          campaignId: camp.id,
          artifactRecordId: artifact.id,
          channel: "linkedin",
          touchType: "impression",
        })
        .returning();
      if (!touch) throw new Error("campaign_touch insert returned no row");

      expect(touch.utmJson).toEqual({});
      expect(touch.personId).toBeNull();
      expect(touch.opportunityId).toBeNull();
      expect(touch.artifactRecordId).toBe(artifact.id);
      // Append-only: no version, no updated_at columns exist on the row.
      expect("version" in touch).toBe(false);
      expect("updatedAt" in touch).toBe(false);

      const [reread] = await ctx.db
        .select()
        .from(campaignTouch)
        .where(eq(campaignTouch.id, touch.id));
      expect(reread).toMatchObject({ campaignId: camp.id, artifactRecordId: artifact.id });

      // campaign_id is a required FK — a bogus value is rejected.
      await expect(ctx.db.insert(campaignTouch).values({ campaignId: NIL_UUID })).rejects.toThrow();

      // artifact_record_id is a nullable FK — a bogus (non-null) value is rejected.
      await expect(
        ctx.db.insert(campaignTouch).values({ campaignId: camp.id, artifactRecordId: NIL_UUID }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});

describe("enrollment_opportunity.campaign_id deferred FK lands (issue #91 P1.6)", () => {
  it("FOS1-CAMP-06: campaign_id now enforces the FK — null is allowed, a valid campaign id is accepted, a bogus non-null id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
      const person = await seedPerson(ctx.db, workspace.id);

      // Null campaign_id is allowed (unattributed opportunity).
      const bare = await seedOpportunity(ctx.db, {
        workspaceId: workspace.id,
        productId: product.id,
        personId: person.id,
      });
      expect(bare.campaignId).toBeNull();

      // A valid campaign id is accepted.
      const [camp] = await ctx.db
        .insert(campaign)
        .values({ workspaceId: workspace.id, productId: product.id, campaignKey: "c", name: "C" })
        .returning();
      if (!camp) throw new Error("campaign insert returned no row");

      const [attributed] = await ctx.db
        .insert(enrollmentOpportunity)
        .values({
          workspaceId: workspace.id,
          productId: product.id,
          personId: person.id,
          campaignId: camp.id,
        })
        .returning();
      expect(attributed?.campaignId).toBe(camp.id);

      // A bogus (non-null) campaign_id is now rejected by the FK.
      await expect(
        ctx.db.insert(enrollmentOpportunity).values({
          workspaceId: workspace.id,
          productId: product.id,
          personId: person.id,
          campaignId: NIL_UUID,
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});
