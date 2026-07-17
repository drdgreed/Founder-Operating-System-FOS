import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./pglite-db.js";
import { seedWorkspaceAndProduct, seedArtifactWithStatus } from "./fixtures.js";
import {
  transitionArtifactVersionStatus,
  IllegalArtifactTransitionError,
  StaleArtifactVersionError,
} from "../artifact-service.js";
import {
  LEGAL_ARTIFACT_EDGES,
  ILLEGAL_ARTIFACT_EDGES,
  ARTIFACT_STATUSES,
  ARTIFACT_TRANSITION_EVENTS,
  eventForArtifactTransition,
} from "../artifact-transitions.js";
import { artifactVersion } from "../../schema/artifact_version.js";
import { artifactRecord } from "../../schema/artifact_record.js";
import { artifactLifecycleStatusEnum } from "../../schema/artifact_record.js";
import { operationalEvent } from "../../schema/operational_event.js";

const ACTOR = { type: "founder" as const, id: "founder-1" };

describe("artifact version transition service (spec §12.2 — full transition matrix)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;
  let workspaceId: string;
  let productId: string;

  beforeEach(async () => {
    ctx = await createTestDb();
    const seeded = await seedWorkspaceAndProduct(ctx.db);
    workspaceId = seeded.workspace.id;
    productId = seeded.product.id;
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("FOS0-ART-09: the §12.2 pgEnum state set matches the state-machine data (no drift)", () => {
    expect([...artifactLifecycleStatusEnum.enumValues].sort()).toEqual(
      [...ARTIFACT_STATUSES].sort(),
    );
    expect(ARTIFACT_STATUSES).toHaveLength(10);
  });

  it("FOS0-ART-09b: the (from→to)→event map (PATCH-SET-02 §A) covers exactly the 14 legal edges — no generic status_changed", () => {
    const mappedEdges = ARTIFACT_STATUSES.flatMap((from) =>
      Object.keys(ARTIFACT_TRANSITION_EVENTS[from]).map((to) => `${from}->${to}`),
    ).sort();
    const legalEdges = LEGAL_ARTIFACT_EDGES.map(([from, to]) => `${from}->${to}`).sort();
    expect(mappedEdges).toEqual(legalEdges);
    expect(mappedEdges).toHaveLength(14);

    // No event maps to the retired generic name.
    const allEvents = ARTIFACT_STATUSES.flatMap((from) =>
      Object.values(ARTIFACT_TRANSITION_EVENTS[from]),
    );
    expect(allEvents).not.toContain("artifact.status_changed");
  });

  it(`FOS0-ART-10: covers all ${LEGAL_ARTIFACT_EDGES.length} legal §12.2 edges — each succeeds, updates approval_status + record mirror, emits its SPECIFIC §A event`, async () => {
    expect(LEGAL_ARTIFACT_EDGES.length).toBe(14);

    for (const [from, to] of LEGAL_ARTIFACT_EDGES) {
      const { record, version } = await seedArtifactWithStatus(ctx.db, {
        workspaceId,
        productId,
        status: from,
      });

      const result = await transitionArtifactVersionStatus(ctx.db, {
        versionId: version.id,
        expectedStatus: from,
        toStatus: to,
        actor: ACTOR,
      });
      expect(result.fromStatus).toBe(from);
      expect(result.toStatus).toBe(to);

      const [v] = await ctx.db
        .select()
        .from(artifactVersion)
        .where(eq(artifactVersion.id, version.id));
      expect(v!.approvalStatus).toBe(to);

      // mirror synced (this seeded version is the record's current version)
      const [r] = await ctx.db
        .select()
        .from(artifactRecord)
        .where(eq(artifactRecord.id, record.id));
      expect(r!.status).toBe(to);

      const events = await ctx.db
        .select()
        .from(operationalEvent)
        .where(eq(operationalEvent.entityId, version.id));
      expect(events).toHaveLength(1);
      // Granular §A event — the specific name for THIS edge, not a generic one.
      expect(events[0]!.type).toBe(eventForArtifactTransition(from, to));
      // §C lifecycle payload shape.
      expect(events[0]!.payload).toEqual({
        artifactId: record.id,
        versionId: version.id,
        fromStatus: from,
        toStatus: to,
      });
    }
  });

  it(`FOS0-ART-11: rejects all ${ILLEGAL_ARTIFACT_EDGES.length} illegal §12.2 pairs (incl. self-transitions) — throws, no status change, no event`, async () => {
    // 10 states x 10 states minus the 14 legal edges.
    expect(ILLEGAL_ARTIFACT_EDGES.length).toBe(100 - 14);

    for (const [from, to] of ILLEGAL_ARTIFACT_EDGES) {
      const { record, version } = await seedArtifactWithStatus(ctx.db, {
        workspaceId,
        productId,
        status: from,
      });

      await expect(
        transitionArtifactVersionStatus(ctx.db, {
          versionId: version.id,
          expectedStatus: from,
          toStatus: to,
          actor: ACTOR,
        }),
      ).rejects.toBeInstanceOf(IllegalArtifactTransitionError);

      const [v] = await ctx.db
        .select()
        .from(artifactVersion)
        .where(eq(artifactVersion.id, version.id));
      expect(v!.approvalStatus).toBe(from); // unchanged

      const [r] = await ctx.db
        .select()
        .from(artifactRecord)
        .where(eq(artifactRecord.id, record.id));
      expect(r!.status).toBe(from); // mirror unchanged

      const events = await ctx.db
        .select()
        .from(operationalEvent)
        .where(eq(operationalEvent.entityId, version.id));
      expect(events).toHaveLength(0); // nothing emitted
    }
  });

  it("FOS0-ART-12: a stale-status (optimistic-concurrency) transition is rejected and emits nothing", async () => {
    const { version } = await seedArtifactWithStatus(ctx.db, {
      workspaceId,
      productId,
      status: "in_review",
    });

    // Caller believes the version is still `draft` (stale view) and tries a
    // draft-legal edge; actual status is `in_review` -> rejected.
    await expect(
      transitionArtifactVersionStatus(ctx.db, {
        versionId: version.id,
        expectedStatus: "draft",
        toStatus: "superseded",
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(StaleArtifactVersionError);

    const [v] = await ctx.db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.id, version.id));
    expect(v!.approvalStatus).toBe("in_review");

    const events = await ctx.db
      .select()
      .from(operationalEvent)
      .where(eq(operationalEvent.entityId, version.id));
    expect(events).toHaveLength(0);
  });
});
