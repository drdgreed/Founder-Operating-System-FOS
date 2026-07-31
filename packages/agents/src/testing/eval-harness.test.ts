import { describe, expect, it } from "vitest";
import {
  createEvalDb,
  createStubNotionClient,
  seedEnrollmentBriefFixture,
  setEvalFeatureFlag,
  stubComplianceReviewer,
} from "./eval-harness.js";

/**
 * Every test here builds a real PGlite database and runs the migrations, so
 * each carries an explicit 120s budget rather than vitest's 5s default.
 *
 * FOS1-EVALHX-01 failed intermittently in the FULL suite (5.4s, then 7.5s)
 * while passing alone in 1.9s — it runs first and pays PGlite's WASM init and
 * the migration cost cold, which exceeds 5s under parallel contention. It was
 * carried as an unexplained flake (F-V) for two rounds before being named.
 * A timeout tuned for a quiet machine is not a test of anything.
 */
describe("eval harness", () => {
  it("FOS1-EVALHX-01: seeds an isolated workspace with a real opportunity chain", async () => {
    const ctx = await createEvalDb();
    try {
      const fixture = await seedEnrollmentBriefFixture(ctx.db);
      expect(fixture.workspace.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(fixture.opportunity.workspaceId).toBe(fixture.workspace.id);
      expect(fixture.application.opportunityId).toBe(fixture.opportunity.id);
    } finally {
      await ctx.close();
    }
  }, 120_000);

  it("FOS1-EVALHX-02: upserts a feature flag", async () => {
    const ctx = await createEvalDb();
    try {
      const workspace = (await seedEnrollmentBriefFixture(ctx.db)).workspace;
      const flag = await setEvalFeatureFlag(ctx.db, {
        workspaceId: workspace.id,
        key: "fos.enrollment_brief",
        enabled: true,
        mode: "review",
      });
      expect(flag.enabled).toBe(true);
      expect(flag.mode).toBe("review");
    } finally {
      await ctx.close();
    }
  }, 120_000);

  it("FOS1-EVALHX-03: the stub Notion client records calls and never touches the network", async () => {
    const { client, calls } = createStubNotionClient();
    const page = (await client.createPage({
      parentDataSourceId: "stub-data-source",
      properties: {},
    })) as { id: string };
    expect(page.id).toMatch(/^stub-notion-page-/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
  }, 120_000);

  it("FOS1-EVALHX-04: the stub compliance reviewer always allows, so stage 7b never blocks offline", async () => {
    await expect(stubComplianceReviewer("we guarantee you a job")).resolves.toEqual({
      verdict: "allow",
      reason: "stub reviewer (offline eval): stage 7b is not exercised in dry-run mode",
    });
  }, 120_000);
});
