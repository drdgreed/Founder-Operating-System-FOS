import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createRealPgTestDb } from "./postgres-db.js";
import { seedWorkspaceAndProduct, seedArtifactWithStatus } from "./fixtures.js";
import { transitionArtifactVersionStatus, StaleArtifactVersionError } from "../artifact-service.js";
import { artifactVersion } from "../../schema/artifact_version.js";
import { artifactRecord } from "../../schema/artifact_record.js";
import { operationalEvent } from "../../schema/operational_event.js";

const ACTOR = { type: "founder" as const, id: "founder-1" };

/**
 * FOS0-ART-CC-*: true-concurrency coverage for the `approval_status` CAS
 * (issue #10, 0.1b follow-up). PGlite is single-connection, so the
 * concurrent-loser branch (artifact-service.ts:265-267 — a second writer's
 * UPDATE matching zero rows because a racing writer already changed the row)
 * can never actually race there; it only ever gets hit sequentially. This
 * suite runs against a real multi-connection Postgres (`DATABASE_URL`, the
 * same server CI already provisions) and fires genuinely concurrent callers
 * at the same row. Skipped when no real Postgres is reachable (e.g. local
 * dev without one running) so `npm test` still needs no DB server.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "artifact version transition CAS under real concurrency (real Postgres)",
  () => {
    let ctx: Awaited<ReturnType<typeof createRealPgTestDb>>;
    let workspaceId: string;
    let productId: string;

    beforeAll(async () => {
      ctx = await createRealPgTestDb();
      const seeded = await seedWorkspaceAndProduct(ctx.db);
      workspaceId = seeded.workspace.id;
      productId = seeded.product.id;
    });

    afterAll(async () => {
      // operational_event is append-only (DB trigger blocks DELETE, per
      // append-only-event.test.ts) and FK-references workspace/product, so
      // those two can never be cleaned up here — only the two rows with no
      // inbound FK from operational_event are removable. The leftover
      // workspace/product/event rows are harmless (CI's Postgres container is
      // destroyed after each run; local runs just accumulate small fixture
      // rows).
      await ctx.db.delete(artifactVersion).where(eq(artifactVersion.workspaceId, workspaceId));
      await ctx.db.delete(artifactRecord).where(eq(artifactRecord.workspaceId, workspaceId));
      await ctx.close();
    });

    it("FOS0-ART-CC-1: N genuinely concurrent CAS transitions on the same row — exactly one wins, the rest see StaleArtifactVersionError, exactly one event is emitted", async () => {
      const { version } = await seedArtifactWithStatus(ctx.db, {
        workspaceId,
        productId,
        status: "draft",
      });

      // Every racer reads the SAME expected status and races the SAME row
      // across separate pooled connections — real concurrent execution, not
      // the sequential single-connection calls the earlier FOS0-ART-12 test
      // is limited to.
      const racers = ["in_review", "superseded", "in_review", "superseded", "in_review"] as const;
      const results = await Promise.allSettled(
        racers.map((toStatus) =>
          transitionArtifactVersionStatus(ctx.db, {
            versionId: version.id,
            expectedStatus: "draft",
            toStatus,
            actor: ACTOR,
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(racers.length - 1);
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(StaleArtifactVersionError);
      }

      const winner = (fulfilled[0] as PromiseFulfilledResult<{ toStatus: string }>).value;

      const [v] = await ctx.db
        .select()
        .from(artifactVersion)
        .where(eq(artifactVersion.id, version.id));
      expect(v!.approvalStatus).toBe(winner.toStatus);

      // No double-apply: exactly one event for this version despite N racers.
      const events = await ctx.db
        .select()
        .from(operationalEvent)
        .where(eq(operationalEvent.entityId, version.id));
      expect(events).toHaveLength(1);
    });
  },
);
