import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { NotionClient, type FetchLike } from "@fos/notion";
import {
  fosWorkspace,
  product,
  person,
  enrollmentOpportunity,
  workspaceCommand,
  operationalEvent,
} from "@fos/db/schema";
import { executeStageCommands } from "../execute-stage-commands.js";
import { createRealPgTestDb } from "./postgres-test-db.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A mock NotionClient that tolerates concurrent createPage/updatePageProperties
 * calls (real HTTP would, too — the assertion here is about our OWN DB CAS,
 * not Notion's). */
function makeMockNotion() {
  const fetchImpl: FetchLike = async (path, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && path.endsWith("/pages")) {
      return jsonResponse(200, { object: "page", id: "notion-page-concurrency" });
    }
    if (method === "PATCH" && path.includes("/pages/")) {
      return jsonResponse(200, { object: "page", id: path.split("/pages/")[1] });
    }
    throw new Error(`unexpected call in mock: ${method} ${path}`);
  };
  return new NotionClient({ fetchImpl, requestsPerSecond: 100 });
}

/**
 * FOS0-EXE-11 (issue #38 item 2): the executor's no-double-execution
 * guarantee (optimistic version-CAS in `transitionOpportunity` + `WHERE
 * status='received'`) was previously verified only by code inspection and a
 * SEQUENTIAL idempotency test (FOS0-EXE-05) — PGlite is single-connection,
 * so a genuine race between two `executeStageCommands` runs can never
 * actually happen there. This suite runs against a real multi-connection
 * Postgres (`DATABASE_URL`, the same server CI already provisions) and
 * fires N genuinely concurrent runs at the SAME received command. Skipped
 * when no real Postgres is reachable, so `npm test` still needs no DB server.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "executeStageCommands under real concurrency (real Postgres, issue #38 item 2)",
  () => {
    let ctx: Awaited<ReturnType<typeof createRealPgTestDb>>;
    let workspaceId: string;
    let productId: string;

    beforeAll(async () => {
      ctx = await createRealPgTestDb();
      const [workspace] = await ctx.db
        .insert(fosWorkspace)
        .values({ name: "Concurrency Test Workspace", ownerUserId: "founder-1" })
        .returning();
      workspaceId = workspace!.id;
      const [prod] = await ctx.db
        .insert(product)
        .values({
          workspaceId,
          productKey: "concurrency-product",
          name: "Concurrency Product",
          productType: "product",
          parentProductId: null,
        })
        .returning();
      productId = prod!.id;
    });

    afterAll(async () => {
      // operational_event is append-only (DB trigger blocks DELETE) and
      // FK-references workspace/product, so those two can't be cleaned up
      // here — harmless (CI's Postgres container is destroyed after each
      // run), mirroring the other real-Postgres concurrency suites.
      await ctx.db.delete(workspaceCommand).where(eq(workspaceCommand.workspaceId, workspaceId));
      await ctx.db
        .delete(enrollmentOpportunity)
        .where(eq(enrollmentOpportunity.workspaceId, workspaceId));
      await ctx.db.delete(person).where(eq(person.workspaceId, workspaceId));
      await ctx.close();
    });

    it("FOS0-EXE-11: N genuinely concurrent executeStageCommands runs against the SAME received command — exactly one executes, canonical version bumped ONCE, never double-applied", async () => {
      const [personRow] = await ctx.db
        .insert(person)
        .values({
          workspaceId,
          firstName: "Grace",
          lastName: "Hopper",
          source: "website_application",
          lifecycleType: "applicant",
        })
        .returning();
      const [opportunity] = await ctx.db
        .insert(enrollmentOpportunity)
        .values({
          workspaceId,
          productId,
          personId: personRow!.id,
          stage: "new_lead",
          currency: "USD",
          version: 1,
        })
        .returning();
      const [command] = await ctx.db
        .insert(workspaceCommand)
        .values({
          workspaceId,
          workspaceIntegrationId: null,
          sourceProviderRecordId: "notion-page-concurrency",
          commandType: "propose_opportunity_stage_change",
          targetEntityType: "EnrollmentOpportunity",
          targetEntityId: opportunity!.id,
          targetVersion: 1,
          payloadJson: { from: "new_lead", to: "reviewing" },
          status: "received",
          idempotencyKey: `concurrency-key-${opportunity!.id}`,
        })
        .returning();

      const client = makeMockNotion();
      const args = { workspaceId, dataSourceId: "data-source-concurrency" };

      // N genuinely concurrent runs, each racing to load + execute the SAME
      // `received` command over its own pooled connection.
      const results = await Promise.all(
        Array.from({ length: 5 }, () => executeStageCommands(ctx.db, client, args)),
      );

      const totalSucceeded = results.reduce((sum, r) => sum + r.succeeded, 0);
      expect(totalSucceeded).toBe(1);

      const [finalOpportunity] = await ctx.db
        .select()
        .from(enrollmentOpportunity)
        .where(eq(enrollmentOpportunity.id, opportunity!.id));
      expect(finalOpportunity!.stage).toBe("reviewing");
      // NOT double-bumped — exactly one CAS won, every other racer's
      // transitionOpportunity call saw a StaleVersionError.
      expect(finalOpportunity!.version).toBe(2);

      const [finalCommand] = await ctx.db
        .select()
        .from(workspaceCommand)
        .where(eq(workspaceCommand.id, command!.id));
      // The one winner's `succeeded` write is never clobbered by a losing
      // racer's own (guarded, no-op) attempt to mark the command `conflict`.
      expect(finalCommand!.status).toBe("succeeded");

      const stageEvents = await ctx.db
        .select()
        .from(operationalEvent)
        .where(eq(operationalEvent.entityId, opportunity!.id));
      expect(stageEvents.filter((e) => e.type === "opportunity.stage_changed")).toHaveLength(1);
    });
  },
);
