import { z } from "zod";
import { and, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  enrollmentOpportunity,
  campaign,
  campaignTouch,
  operationalEvent,
  agentRun,
  interaction,
} from "@fos/db/schema";
import { OPPORTUNITY_STAGES, type Db } from "@fos/db/services";
import type { Principal } from "./auth.js";
import type { HandlerResult } from "./handlers.js";

/**
 * Read-only dashboard aggregation cores (spec §7.2 / §9.4 step 8; P1.9).
 *
 * Each function takes `(db, principal, ...)` so tests inject a hermetic PGlite
 * db and a server-derived principal — the routes are thin GET adapters over
 * these (mirrors `apps/api/lib/handlers.ts`). Every query is TENANT-SCOPED to
 * `principal.workspaceId`: a cross-workspace read is a tenant leak, so the
 * workspace filter is non-negotiable on every table touched.
 *
 * `campaign_touch` carries NO `workspace_id` of its own — it is scoped
 * transitively via its NOT-NULL `campaign_id` FK, so the attribution query
 * filters on `campaign.workspace_id` (the direct-scoping convention). The
 * enrollment join additionally re-asserts `workspace_id` equality as
 * defense-in-depth against a malformed cross-tenant `opportunity_id`.
 *
 * All results are plain typed JSON. Numeric aggregates are coerced with
 * `Number(...)` because Postgres returns `count(*)` (int8) as a string over
 * both drivers; the `::int` cast keeps it in int4 range and the coercion
 * yields a real JS number.
 */

// ─── Funnel ──────────────────────────────────────────────────────────────────

export interface FunnelResult {
  workspaceId: string;
  totalOpportunities: number;
  /** Every canonical stage present, zero-filled — never a sparse map. */
  byStage: Record<string, number>;
  /**
   * Snapshot conversion: how many opportunities are CURRENTLY in `enrolled`
   * over the total. This is a current-stage snapshot, not a stage-history
   * progression rate (stage history lives in operational_event, out of scope
   * for this slice). `rate` is 0 when there are zero opportunities.
   */
  conversion: { enrolled: number; total: number; rate: number };
}

export async function getFunnel(db: Db, principal: Principal): Promise<FunnelResult> {
  const rows = await db
    .select({
      stage: enrollmentOpportunity.stage,
      count: sql<number>`count(*)::int`,
    })
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.workspaceId, principal.workspaceId))
    .groupBy(enrollmentOpportunity.stage);

  const byStage: Record<string, number> = {};
  for (const stage of OPPORTUNITY_STAGES) byStage[stage] = 0;

  let total = 0;
  for (const row of rows) {
    const n = Number(row.count);
    byStage[row.stage] = n;
    total += n;
  }

  const enrolled = byStage.enrolled ?? 0;
  return {
    workspaceId: principal.workspaceId,
    totalOpportunities: total,
    byStage,
    conversion: { enrolled, total, rate: total === 0 ? 0 : enrolled / total },
  };
}

// ─── Campaign attribution ────────────────────────────────────────────────────

export interface AttributionRow {
  campaignId: string;
  campaignKey: string;
  campaignName: string;
  /** Total campaign_touch rows attributed to this campaign. */
  touches: number;
  /**
   * Distinct opportunities touched by this campaign that are CURRENTLY in the
   * `enrolled` stage (the funnel outcome). Distinct because one opportunity may
   * accrue many touches from the same campaign.
   */
  enrollments: number;
}

export interface AttributionResult {
  workspaceId: string;
  campaigns: AttributionRow[];
}

export async function getAttribution(db: Db, principal: Principal): Promise<AttributionResult> {
  const rows = await db
    .select({
      campaignId: campaign.id,
      campaignKey: campaign.campaignKey,
      campaignName: campaign.name,
      touches: sql<number>`count(${campaignTouch.id})::int`,
      enrollments: sql<number>`count(distinct case when ${enrollmentOpportunity.stage} = 'enrolled' then ${enrollmentOpportunity.id} end)::int`,
    })
    .from(campaign)
    // LEFT joins so a campaign with zero touches still returns a 0/0 row.
    .leftJoin(campaignTouch, eq(campaignTouch.campaignId, campaign.id))
    .leftJoin(
      enrollmentOpportunity,
      and(
        eq(enrollmentOpportunity.id, campaignTouch.opportunityId),
        // Re-assert tenant equality on the outcome join (defense-in-depth).
        eq(enrollmentOpportunity.workspaceId, campaign.workspaceId),
      ),
    )
    .where(eq(campaign.workspaceId, principal.workspaceId))
    .groupBy(campaign.id, campaign.campaignKey, campaign.name)
    .orderBy(campaign.campaignKey);

  return {
    workspaceId: principal.workspaceId,
    campaigns: rows.map((r) => ({
      campaignId: r.campaignId,
      campaignKey: r.campaignKey,
      campaignName: r.campaignName,
      touches: Number(r.touches),
      enrollments: Number(r.enrollments),
    })),
  };
}

// ─── Founder-time instrumentation ────────────────────────────────────────────

/**
 * Optional observation window. `from`/`to` are ISO-8601 strings coerced to
 * dates; an unparseable value yields a 400 at the core (never a crash). The
 * three named sources are windowed on their most meaningful timestamp:
 * operational_event on `occurred_at` (event time, NOT NULL), agent_run and
 * interaction on `created_at` (record-write time — neither has a single
 * canonical event-time column).
 */
const windowSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();

export interface FounderTimeResult {
  workspaceId: string;
  window: { from: string | null; to: string | null };
  counts: {
    /** operational_event rows — the founder/agent decision + activity spine. */
    decisions: number;
    /** agent_run rows — automation the founder oversaw. */
    agentRuns: number;
    /** interaction rows — conversations/touchpoints recorded. */
    interactions: number;
  };
}

/** Builds a workspace-scoped WHERE, ANDed with an optional [from,to] on `col`. */
function scopedWindow(
  workspaceClause: SQL,
  timeCol: Parameters<typeof gte>[0],
  from?: Date,
  to?: Date,
): SQL | undefined {
  const clauses: (SQL | undefined)[] = [workspaceClause];
  if (from) clauses.push(gte(timeCol, from));
  if (to) clauses.push(lte(timeCol, to));
  return and(...clauses);
}

async function countRows(
  db: Db,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle table union; count(*) is table-agnostic
  table: any,
  where: SQL | undefined,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(where);
  return Number(rows[0]?.count ?? 0);
}

export async function getFounderTime(
  db: Db,
  principal: Principal,
  rawWindow: unknown,
): Promise<HandlerResult> {
  const parsed = windowSchema.safeParse(rawWindow ?? {});
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: "invalid window", fields: parsed.error.flatten().fieldErrors },
    };
  }
  const { from, to } = parsed.data;
  const ws = principal.workspaceId;

  const [decisions, agentRuns, interactions] = await Promise.all([
    countRows(
      db,
      operationalEvent,
      scopedWindow(eq(operationalEvent.workspaceId, ws), operationalEvent.occurredAt, from, to),
    ),
    countRows(
      db,
      agentRun,
      scopedWindow(eq(agentRun.workspaceId, ws), agentRun.createdAt, from, to),
    ),
    countRows(
      db,
      interaction,
      scopedWindow(eq(interaction.workspaceId, ws), interaction.createdAt, from, to),
    ),
  ]);

  const result: FounderTimeResult = {
    workspaceId: ws,
    window: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
    counts: { decisions, agentRuns, interactions },
  };
  return { status: 200, body: result };
}
