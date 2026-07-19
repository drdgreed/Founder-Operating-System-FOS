import { describe, it, expect } from "vitest";
import { sql, eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct, seedPerson, seedOpportunity } from "./fixtures.js";
import { agentRun } from "../../schema/agent_run.js";
import { featureFlag } from "../../schema/feature_flag.js";
import { enrollmentAssessment } from "../../schema/enrollment_assessment.js";
import { enrollmentOpportunity } from "../../schema/enrollment_opportunity.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

describe("P1.0 migration applies clean on empty DB (issue #48)", () => {
  it("FOS1-MIG-01: all migrations (incl. agent_run, feature_flag, enrollment_assessment) apply to a fresh PGlite instance; every new table is queryable", async () => {
    const { db, close } = await createTestDb();
    try {
      expect(await db.select().from(agentRun)).toEqual([]);
      expect(await db.select().from(featureFlag)).toEqual([]);
      expect(await db.select().from(enrollmentAssessment)).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("agent_run entity (ADR-07 D5, issue #48)", () => {
  it("FOS1-MIG-02: an agent_run row inserts and reads back with defaults applied (status=queued, retry_count=0)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);
      const correlationId = crypto.randomUUID();

      const [inserted] = await ctx.db
        .insert(agentRun)
        .values({
          workspaceId: workspace.id,
          agentKey: "fos.enrollment_brief",
          agentVersion: "1",
          promptVersion: "1",
          trigger: "opportunity.created",
          actorJson: { type: "agent", id: "fos.enrollment_brief" },
          featureMode: "shadow",
          contextManifestJson: { sources: [] },
          correlationId,
        })
        .returning();
      if (!inserted) throw new Error("agent_run insert returned no row");

      expect(inserted.status).toBe("queued");
      expect(inserted.retryCount).toBe(0);
      expect(inserted.inputRef).toBeNull();
      expect(inserted.causationId).toBeNull();

      const [reread] = await ctx.db.select().from(agentRun).where(eq(agentRun.id, inserted.id));
      expect(reread).toMatchObject({
        workspaceId: workspace.id,
        agentKey: "fos.enrollment_brief",
        featureMode: "shadow",
        status: "queued",
        correlationId,
      });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-MIG-03: workspace_id is a required FK — a bogus workspace_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      await expect(
        ctx.db.insert(agentRun).values({
          workspaceId: NIL_UUID,
          agentKey: "fos.enrollment_brief",
          agentVersion: "1",
          promptVersion: "1",
          trigger: "opportunity.created",
          actorJson: {},
          featureMode: "shadow",
          contextManifestJson: {},
          correlationId: crypto.randomUUID(),
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-MIG-04: status enum is enforced — an unregistered value is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);
      await expect(
        ctx.db.execute(sql`
          INSERT INTO agent_run
            (workspace_id, agent_key, agent_version, prompt_version, trigger, actor_json,
             feature_mode, context_manifest_json, status, correlation_id)
          VALUES
            (${workspace.id}, 'fos.enrollment_brief', '1', '1', 'opportunity.created', '{}'::jsonb,
             'shadow', '{}'::jsonb, 'not_a_real_status', ${crypto.randomUUID()})
        `),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-MIG-05: feature_mode enum is enforced — an unregistered value is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);
      await expect(
        ctx.db.execute(sql`
          INSERT INTO agent_run
            (workspace_id, agent_key, agent_version, prompt_version, trigger, actor_json,
             feature_mode, context_manifest_json, correlation_id)
          VALUES
            (${workspace.id}, 'fos.enrollment_brief', '1', '1', 'opportunity.created', '{}'::jsonb,
             'production', '{}'::jsonb, ${crypto.randomUUID()})
        `),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});

describe("feature_flag entity (ADR-07 D8, issue #48)", () => {
  it("FOS1-MIG-06: a feature_flag row inserts and reads back with defaults applied (enabled=false, mode=shadow)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);

      const [inserted] = await ctx.db
        .insert(featureFlag)
        .values({ workspaceId: workspace.id, key: "agent_runtime" })
        .returning();
      if (!inserted) throw new Error("feature_flag insert returned no row");

      expect(inserted.enabled).toBe(false);
      expect(inserted.mode).toBe("shadow");

      const [reread] = await ctx.db
        .select()
        .from(featureFlag)
        .where(eq(featureFlag.id, inserted.id));
      expect(reread).toMatchObject({
        workspaceId: workspace.id,
        key: "agent_runtime",
        enabled: false,
        mode: "shadow",
      });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-MIG-07: UNIQUE (workspace_id, key) rejects a duplicate key for the same workspace", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);

      await ctx.db.insert(featureFlag).values({ workspaceId: workspace.id, key: "agent_runtime" });

      await expect(
        ctx.db.insert(featureFlag).values({ workspaceId: workspace.id, key: "agent_runtime" }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-MIG-08: workspace_id is a required FK — a bogus workspace_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      await expect(
        ctx.db.insert(featureFlag).values({ workspaceId: NIL_UUID, key: "agent_runtime" }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-MIG-09: mode enum is enforced — an unregistered value is rejected", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);
      await expect(
        ctx.db.execute(sql`
          INSERT INTO feature_flag (workspace_id, key, mode)
          VALUES (${workspace.id}, 'agent_runtime', 'production')
        `),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});

describe("enrollment_assessment entity (spec §6.4, issue #48)", () => {
  async function seedFullOpportunity(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
    const { workspace, product } = await seedWorkspaceAndProduct(db);
    const person = await seedPerson(db, workspace.id);
    const opportunity = await seedOpportunity(db, {
      workspaceId: workspace.id,
      productId: product.id,
      personId: person.id,
    });
    return { workspace, product, person, opportunity };
  }

  it("FOS1-MIG-10: an enrollment_assessment row inserts and reads back with defaults applied (version=1, json containers={})", async () => {
    const ctx = await createTestDb();
    try {
      const { opportunity } = await seedFullOpportunity(ctx.db);

      const [inserted] = await ctx.db
        .insert(enrollmentAssessment)
        .values({ opportunityId: opportunity.id })
        .returning();
      if (!inserted) throw new Error("enrollment_assessment insert returned no row");

      expect(inserted.version).toBe(1);
      expect(inserted.observedFactsJson).toEqual({});
      expect(inserted.inferencesJson).toEqual({});
      expect(inserted.unknownsJson).toEqual({});
      expect(inserted.riskFlagsJson).toEqual({});
      expect(inserted.agentRunId).toBeNull();
      expect(inserted.fitStatus).toBeNull();

      const [reread] = await ctx.db
        .select()
        .from(enrollmentAssessment)
        .where(eq(enrollmentAssessment.id, inserted.id));
      expect(reread).toMatchObject({ opportunityId: opportunity.id, version: 1 });
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-MIG-11: opportunity_id is a required FK — a bogus opportunity_id is rejected", async () => {
    const ctx = await createTestDb();
    try {
      await expect(
        ctx.db.insert(enrollmentAssessment).values({ opportunityId: NIL_UUID }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it("FOS1-MIG-12: agent_run_id FK to agent_run holds (nullable allowed; a bogus non-null value is rejected)", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace } = await seedWorkspaceAndProduct(ctx.db);
      const { opportunity } = await seedFullOpportunity(ctx.db);

      // Nullable allowed.
      const [withoutRun] = await ctx.db
        .insert(enrollmentAssessment)
        .values({ opportunityId: opportunity.id })
        .returning();
      expect(withoutRun?.agentRunId).toBeNull();

      // Holds against a real agent_run row.
      const [run] = await ctx.db
        .insert(agentRun)
        .values({
          workspaceId: workspace.id,
          agentKey: "fos.enrollment_brief",
          agentVersion: "1",
          promptVersion: "1",
          trigger: "opportunity.created",
          actorJson: {},
          featureMode: "shadow",
          contextManifestJson: {},
          correlationId: crypto.randomUUID(),
        })
        .returning();
      if (!run) throw new Error("agent_run insert returned no row");

      const [withRun] = await ctx.db
        .insert(enrollmentAssessment)
        .values({ opportunityId: opportunity.id, agentRunId: run.id })
        .returning();
      expect(withRun?.agentRunId).toBe(run.id);

      // Rejects a bogus (non-null) agent_run_id.
      await expect(
        ctx.db
          .insert(enrollmentAssessment)
          .values({ opportunityId: opportunity.id, agentRunId: NIL_UUID }),
      ).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });
});

describe("enrollment_opportunity attribution extensions (spec §6.1, issue #48)", () => {
  it("FOS1-MIG-13: the 4 new fields default to null and round-trip when set", async () => {
    const ctx = await createTestDb();
    try {
      const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
      const person = await seedPerson(ctx.db, workspace.id);

      const [bare] = await ctx.db
        .insert(enrollmentOpportunity)
        .values({ workspaceId: workspace.id, productId: product.id, personId: person.id })
        .returning();
      if (!bare) throw new Error("enrollment_opportunity insert returned no row");
      expect(bare.campaignId).toBeNull();
      expect(bare.firstTouchSource).toBeNull();
      expect(bare.lastTouchSource).toBeNull();
      expect(bare.attributionConfidence).toBeNull();

      const campaignId = crypto.randomUUID();
      const [populated] = await ctx.db
        .insert(enrollmentOpportunity)
        .values({
          workspaceId: workspace.id,
          productId: product.id,
          personId: person.id,
          campaignId,
          firstTouchSource: "linkedin_post",
          lastTouchSource: "substack_paper",
          attributionConfidence: "high",
        })
        .returning();
      if (!populated) throw new Error("enrollment_opportunity insert returned no row");

      const [reread] = await ctx.db
        .select()
        .from(enrollmentOpportunity)
        .where(eq(enrollmentOpportunity.id, populated.id));
      expect(reread).toMatchObject({
        campaignId,
        firstTouchSource: "linkedin_post",
        lastTouchSource: "substack_paper",
        attributionConfidence: "high",
      });
    } finally {
      await ctx.close();
    }
  });
});
