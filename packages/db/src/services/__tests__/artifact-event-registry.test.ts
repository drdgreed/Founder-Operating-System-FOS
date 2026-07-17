import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct } from "./fixtures.js";
import { writeEvent } from "../event-writer.js";
import { operationalEvent } from "../../schema/operational_event.js";

const ACTOR = { type: "founder" as const, id: "founder-1" };

describe("event writer enforces the artifact payload registry (PATCH-SET-02 §C)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  let workspaceId: string;

  beforeEach(async () => {
    ctx = await createTestDb();
    const seeded = await seedWorkspaceAndProduct(ctx.db);
    workspaceId = seeded.workspace.id;
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("FOS0-ART-50: writeEvent rejects an unregistered artifact.* type and inserts NOTHING", async () => {
    await expect(
      writeEvent(ctx.db, {
        workspaceId,
        entityType: "ArtifactVersion",
        entityId: "some-id",
        source: "api",
        correlationId: "00000000-0000-0000-0000-000000000001",
        actor: ACTOR,
        type: "artifact.frobnicated",
        payload: { anything: true },
      }),
    ).rejects.toThrow(/unregistered artifact event type/i);

    expect(await ctx.db.select().from(operationalEvent)).toHaveLength(0);
  });

  it("FOS0-ART-51: writeEvent rejects a malformed registered artifact payload and inserts NOTHING", async () => {
    await expect(
      writeEvent(ctx.db, {
        workspaceId,
        entityType: "ArtifactVersion",
        entityId: "some-id",
        source: "api",
        correlationId: "00000000-0000-0000-0000-000000000002",
        actor: ACTOR,
        type: "artifact.approved",
        payload: { artifactId: "not-a-uuid", versionId: "x" }, // missing/invalid fields
      }),
    ).rejects.toThrow();

    expect(await ctx.db.select().from(operationalEvent)).toHaveLength(0);
  });

  it("FOS0-ART-52: a non-artifact event with an arbitrary payload still writes (registry scoped to artifact.*)", async () => {
    const written = await writeEvent(ctx.db, {
      workspaceId,
      entityType: "EnrollmentOpportunity",
      entityId: "opp-1",
      source: "api",
      correlationId: "00000000-0000-0000-0000-000000000003",
      actor: ACTOR,
      type: "opportunity.stage_changed",
      payload: { from: "new_lead", to: "reviewing" },
    });
    expect(written.type).toBe("opportunity.stage_changed");
    expect(await ctx.db.select().from(operationalEvent)).toHaveLength(1);
  });
});
