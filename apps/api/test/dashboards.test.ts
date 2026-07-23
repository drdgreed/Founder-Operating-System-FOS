import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { getFunnel, getAttribution, getFounderTime } from "../lib/dashboards.js";
import {
  createTestDb,
  seedWorkspaceAndProduct,
  seedPerson,
  seedOpportunity,
  seedCampaign,
  seedCampaignTouch,
  seedOperationalEvent,
  seedAgentRun,
  seedInteraction,
} from "./helpers.js";
import type { Principal } from "../lib/auth.js";
import { GET as funnelGET } from "../app/api/fos/dashboard/funnel/route.js";
import { GET as attributionGET } from "../app/api/fos/dashboard/attribution/route.js";
import { GET as founderTimeGET } from "../app/api/fos/dashboard/founder-time/route.js";

const SYSTEM_PRINCIPAL = (workspaceId: string): Principal => ({
  workspaceId,
  actor: { type: "system", id: "service-account" },
});

// ─── Aggregation cores (happy path / workspace scoping / empty / window) ──────

describe("dashboard aggregation cores (P1.9)", () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    ctx = await createTestDb();
  });
  afterEach(async () => {
    await ctx.close();
  });

  // ── Funnel ──
  it("FOS1-DASH-FUNNEL-01: counts opportunities per stage and computes snapshot conversion", async () => {
    const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
    const p = await seedPerson(ctx.db, workspace.id);
    const wp = { workspaceId: workspace.id, productId: product.id, personId: p.id };
    await seedOpportunity(ctx.db, { ...wp, stage: "new_lead" });
    await seedOpportunity(ctx.db, { ...wp, stage: "new_lead" });
    await seedOpportunity(ctx.db, { ...wp, stage: "reviewing" });
    await seedOpportunity(ctx.db, { ...wp, stage: "enrolled" });

    const res = await getFunnel(ctx.db, SYSTEM_PRINCIPAL(workspace.id));
    expect(res.totalOpportunities).toBe(4);
    expect(res.byStage.new_lead).toBe(2);
    expect(res.byStage.reviewing).toBe(1);
    expect(res.byStage.enrolled).toBe(1);
    expect(res.byStage.declined).toBe(0); // untouched stage is zero-filled, not absent
    expect(res.conversion).toEqual({ enrolled: 1, total: 4, rate: 0.25 });
  });

  it("FOS1-DASH-FUNNEL-02: workspace scoping — opportunities in ANOTHER workspace are NOT counted", async () => {
    const a = await seedWorkspaceAndProduct(ctx.db, "a");
    const b = await seedWorkspaceAndProduct(ctx.db, "b");
    const pa = await seedPerson(ctx.db, a.workspace.id);
    const pb = await seedPerson(ctx.db, b.workspace.id);
    await seedOpportunity(ctx.db, {
      workspaceId: a.workspace.id,
      productId: a.product.id,
      personId: pa.id,
      stage: "new_lead",
    });
    // Two enrolled opps in B — must be invisible to A's funnel.
    await seedOpportunity(ctx.db, {
      workspaceId: b.workspace.id,
      productId: b.product.id,
      personId: pb.id,
      stage: "enrolled",
    });
    await seedOpportunity(ctx.db, {
      workspaceId: b.workspace.id,
      productId: b.product.id,
      personId: pb.id,
      stage: "enrolled",
    });

    const res = await getFunnel(ctx.db, SYSTEM_PRINCIPAL(a.workspace.id));
    expect(res.totalOpportunities).toBe(1);
    expect(res.byStage.new_lead).toBe(1);
    expect(res.byStage.enrolled).toBe(0); // B's enrolled opps leaked NOTHING
    expect(res.conversion.enrolled).toBe(0);
  });

  it("FOS1-DASH-FUNNEL-03: empty data — zero opportunities yields a zero-filled funnel, rate 0 (no divide-by-zero)", async () => {
    const { workspace } = await seedWorkspaceAndProduct(ctx.db);
    const res = await getFunnel(ctx.db, SYSTEM_PRINCIPAL(workspace.id));
    expect(res.totalOpportunities).toBe(0);
    expect(res.byStage.new_lead).toBe(0);
    expect(res.byStage.enrolled).toBe(0);
    expect(res.conversion).toEqual({ enrolled: 0, total: 0, rate: 0 });
  });

  // ── Attribution ──
  it("FOS1-DASH-ATTR-01: per-campaign touches and DISTINCT enrolled outcomes", async () => {
    const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
    const p = await seedPerson(ctx.db, workspace.id);
    const campA = await seedCampaign(ctx.db, {
      workspaceId: workspace.id,
      productId: product.id,
      key: "camp-a",
    });
    const campB = await seedCampaign(ctx.db, {
      workspaceId: workspace.id,
      productId: product.id,
      key: "camp-b",
    });
    const enrolledOpp = await seedOpportunity(ctx.db, {
      workspaceId: workspace.id,
      productId: product.id,
      personId: p.id,
      stage: "enrolled",
    });
    const leadOpp = await seedOpportunity(ctx.db, {
      workspaceId: workspace.id,
      productId: product.id,
      personId: p.id,
      stage: "new_lead",
    });
    // camp-a: 3 touches on the SAME enrolled opp (distinct => 1 enrollment) + 1 on a lead opp.
    await seedCampaignTouch(ctx.db, { campaignId: campA.id, opportunityId: enrolledOpp.id });
    await seedCampaignTouch(ctx.db, { campaignId: campA.id, opportunityId: enrolledOpp.id });
    await seedCampaignTouch(ctx.db, { campaignId: campA.id, opportunityId: enrolledOpp.id });
    await seedCampaignTouch(ctx.db, { campaignId: campA.id, opportunityId: leadOpp.id });
    // camp-b: 1 anonymous touch (no opportunity yet).
    await seedCampaignTouch(ctx.db, { campaignId: campB.id });

    const res = await getAttribution(ctx.db, SYSTEM_PRINCIPAL(workspace.id));
    const rows = Object.fromEntries(res.campaigns.map((c) => [c.campaignKey, c]));
    expect(rows["camp-a"]).toMatchObject({ touches: 4, enrollments: 1 });
    expect(rows["camp-b"]).toMatchObject({ touches: 1, enrollments: 0 });
  });

  it("FOS1-DASH-ATTR-02: workspace scoping — another workspace's campaigns/touches are NOT counted", async () => {
    const a = await seedWorkspaceAndProduct(ctx.db, "a");
    const b = await seedWorkspaceAndProduct(ctx.db, "b");
    const pb = await seedPerson(ctx.db, b.workspace.id);
    const campB = await seedCampaign(ctx.db, {
      workspaceId: b.workspace.id,
      productId: b.product.id,
      key: "camp-b",
    });
    const oppB = await seedOpportunity(ctx.db, {
      workspaceId: b.workspace.id,
      productId: b.product.id,
      personId: pb.id,
      stage: "enrolled",
    });
    await seedCampaignTouch(ctx.db, { campaignId: campB.id, opportunityId: oppB.id });

    // Workspace A has its own campaign with zero touches.
    await seedCampaign(ctx.db, {
      workspaceId: a.workspace.id,
      productId: a.product.id,
      key: "camp-a",
    });

    const res = await getAttribution(ctx.db, SYSTEM_PRINCIPAL(a.workspace.id));
    expect(res.campaigns).toHaveLength(1); // only A's campaign, never B's
    expect(res.campaigns[0]!.campaignKey).toBe("camp-a");
    expect(res.campaigns[0]).toMatchObject({ touches: 0, enrollments: 0 });
  });

  it("FOS1-DASH-ATTR-03: empty data — no campaigns yields an empty list (no crash)", async () => {
    const { workspace } = await seedWorkspaceAndProduct(ctx.db);
    const res = await getAttribution(ctx.db, SYSTEM_PRINCIPAL(workspace.id));
    expect(res.campaigns).toEqual([]);
  });

  // ── Founder-time ──
  it("FOS1-DASH-FT-01: counts decisions, agent runs, and interactions", async () => {
    const { workspace, product } = await seedWorkspaceAndProduct(ctx.db);
    const p = await seedPerson(ctx.db, workspace.id);
    const opp = await seedOpportunity(ctx.db, {
      workspaceId: workspace.id,
      productId: product.id,
      personId: p.id,
      stage: "new_lead",
    });
    const now = new Date();
    await seedOperationalEvent(ctx.db, workspace.id, now);
    await seedOperationalEvent(ctx.db, workspace.id, now);
    await seedAgentRun(ctx.db, workspace.id);
    await seedInteraction(ctx.db, { workspaceId: workspace.id, opportunityId: opp.id });

    const res = await getFounderTime(ctx.db, SYSTEM_PRINCIPAL(workspace.id), {});
    expect(res.status).toBe(200);
    expect((res.body as { counts: unknown }).counts).toEqual({
      decisions: 2,
      agentRuns: 1,
      interactions: 1,
    });
  });

  it("FOS1-DASH-FT-02: workspace scoping — another workspace's instrumentation is NOT counted", async () => {
    const a = await seedWorkspaceAndProduct(ctx.db, "a");
    const b = await seedWorkspaceAndProduct(ctx.db, "b");
    const pb = await seedPerson(ctx.db, b.workspace.id);
    const oppB = await seedOpportunity(ctx.db, {
      workspaceId: b.workspace.id,
      productId: b.product.id,
      personId: pb.id,
      stage: "new_lead",
    });
    const now = new Date();
    // ALL activity lives in workspace B.
    await seedOperationalEvent(ctx.db, b.workspace.id, now);
    await seedAgentRun(ctx.db, b.workspace.id);
    await seedInteraction(ctx.db, { workspaceId: b.workspace.id, opportunityId: oppB.id });

    const res = await getFounderTime(ctx.db, SYSTEM_PRINCIPAL(a.workspace.id), {});
    expect(res.status).toBe(200);
    expect((res.body as { counts: unknown }).counts).toEqual({
      decisions: 0,
      agentRuns: 0,
      interactions: 0,
    });
  });

  it("FOS1-DASH-FT-03: empty data — zero everything", async () => {
    const { workspace } = await seedWorkspaceAndProduct(ctx.db);
    const res = await getFounderTime(ctx.db, SYSTEM_PRINCIPAL(workspace.id), {});
    expect(res.status).toBe(200);
    expect((res.body as { counts: unknown }).counts).toEqual({
      decisions: 0,
      agentRuns: 0,
      interactions: 0,
    });
  });

  it("FOS1-DASH-FT-04: window filters out activity outside [from, to]", async () => {
    const { workspace } = await seedWorkspaceAndProduct(ctx.db);
    const inside = new Date("2026-06-15T12:00:00Z");
    const before = new Date("2026-01-01T00:00:00Z");
    const after = new Date("2026-12-31T00:00:00Z");
    await seedOperationalEvent(ctx.db, workspace.id, inside);
    await seedOperationalEvent(ctx.db, workspace.id, before);
    await seedOperationalEvent(ctx.db, workspace.id, after);

    const res = await getFounderTime(ctx.db, SYSTEM_PRINCIPAL(workspace.id), {
      from: "2026-06-01T00:00:00Z",
      to: "2026-06-30T00:00:00Z",
    });
    expect(res.status).toBe(200);
    expect((res.body as { counts: { decisions: number } }).counts.decisions).toBe(1);
  });

  it("FOS1-DASH-FT-05: an unparseable window -> 400, no crash", async () => {
    const { workspace } = await seedWorkspaceAndProduct(ctx.db);
    const res = await getFounderTime(ctx.db, SYSTEM_PRINCIPAL(workspace.id), {
      from: "not-a-date",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/drizzle|postgres|pglite|stack/i);
  });
});

// ─── Route auth (unauthenticated / unconfigured are rejected BEFORE any db) ───

describe("dashboard route auth (P1.9)", () => {
  const ENV_KEYS = [
    "FOS_SERVICE_TOKEN",
    "FOS_SERVICE_WORKSPACE_ID",
    "FOS_SERVICE_ACTOR_ID",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.FOS_SERVICE_TOKEN = "s3cr3t-service-token";
    process.env.FOS_SERVICE_WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
    delete process.env.FOS_SERVICE_ACTOR_ID;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const routes = [
    ["funnel", funnelGET, "http://localhost/api/fos/dashboard/funnel"],
    ["attribution", attributionGET, "http://localhost/api/fos/dashboard/attribution"],
    ["founder-time", founderTimeGET, "http://localhost/api/fos/dashboard/founder-time"],
  ] as const;

  for (const [name, handler, url] of routes) {
    it(`FOS1-DASH-AUTH-01 (${name}): no Authorization header -> 401 (never reaches the db)`, async () => {
      const res = await handler(new NextRequest(url));
      expect(res.status).toBe(401);
    });

    it(`FOS1-DASH-AUTH-02 (${name}): wrong token -> 401`, async () => {
      const res = await handler(
        new NextRequest(url, { headers: { authorization: "Bearer not-the-token" } }),
      );
      expect(res.status).toBe(401);
    });

    it(`FOS1-DASH-AUTH-03 (${name}): service unconfigured -> 503 (fail closed)`, async () => {
      delete process.env.FOS_SERVICE_TOKEN;
      const res = await handler(
        new NextRequest(url, { headers: { authorization: "Bearer s3cr3t-service-token" } }),
      );
      expect(res.status).toBe(503);
    });
  }
});
