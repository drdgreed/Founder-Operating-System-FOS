import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { fosWorkspace } from "./fos_workspace.js";
import { product } from "./product.js";

/**
 * Campaign (spec §6.2, canonically redefined by PATCH-SET-01 §B2; issue #91
 * P1.6). B2 supersedes both P0 §10.7 and P1 §6.2 with a single reconciled
 * field set; Phase 1 adds NO new Campaign fields. Schema + migration only in
 * this slice — no agent/API/projection/command wiring.
 *
 * - §B0: product-scoped — `product_id` NOT NULL FK -> product (a Campaign
 *   always sells one product). `workspace_id` NOT NULL FK is retained for
 *   tenant isolation (direct-scoping convention, mirrors the other §B0
 *   product-scoped entities).
 * - §C2 (UNVERSIONED): Campaign is an "unversioned canonical entity projected
 *   with FOS Version". There is intentionally NO `version` column — its FOS
 *   Version is DERIVED at projection time as
 *   `extract(epoch from updated_at)::bigint` (monotonic per record, no schema
 *   change). The conflict check compares that epoch, not a stored counter.
 * - §B1/§B2 `offer_id`: reconciled from P0 `offer_code` string to a uuid FK ->
 *   Offer. The `Offer` table lands in a later slice, so `offer_id` is a bare
 *   NULLABLE uuid with NO FK yet — identical convention to
 *   `enrollment_opportunity.offer_id`. FLAG. The FK lands with the Offer slice.
 * - id-array fields (`audience_segment_ids`, `narrative_ids`,
 *   `content_pillar_ids`, `channel_ids`, `secondary_cta_ids`): B2 types these
 *   as `uuid[]`, but their referenced entities (AudienceSegment, Narrative,
 *   ContentPillar, Channel, CTA) do NOT exist yet — none can carry a FK today.
 *   Modeled as jsonb arrays defaulting to `[]` (mirrors the `*_json` container
 *   convention), pending those entities. FLAG — divergence from B2 `uuid[]`.
 * - `primary_cta_id`: uuid nullable, NO FK yet (CTA registry is a later slice).
 *   FLAG.
 * - `status`: P1 §6.2 gives no enum, but §B2 supplies a proposed closed
 *   lifecycle (`draft` -> `active` -> `paused` -> `complete`). A campaign
 *   lifecycle IS a clearly-closed set, so — mirroring
 *   objection_record/enrollment_action_recommendation — it is DB-enforced via
 *   CHECK (over pgEnum), defaulted to `'draft'`. FLAG (value set is §B2
 *   "proposed", not yet ratified).
 * - `budget_amount`: §B2 reconciles P1's `budget_cents` to `budget_amount`
 *   (integer, minor units — unit-consistent with Offer.price_amount). Column
 *   named `budget_amount` per the canonical B2 field set. FLAG — the orchestra-
 *   tor brief referenced the pre-reconciliation name `budget_cents`.
 */
export const campaign = pgTable(
  "campaign",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => fosWorkspace.id),
    // §B0: product-scoped.
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    campaignKey: text("campaign_key").notNull(),
    name: text("name").notNull(),
    objective: text("objective"),
    // §B1/§B2: replaces P0 `offer_code`. `Offer` table + FK land with a later
    // slice — bare nullable uuid, no FK yet (mirrors enrollment_opportunity).
    // FLAG.
    offerId: uuid("offer_id"),
    // id-array fields — jsonb arrays pending the referenced entities. FLAG.
    audienceSegmentIds: jsonb("audience_segment_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    narrativeIds: jsonb("narrative_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    contentPillarIds: jsonb("content_pillar_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    channelIds: jsonb("channel_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    secondaryCtaIds: jsonb("secondary_cta_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // uuid nullable, no FK yet (CTA registry is a later slice). FLAG.
    primaryCtaId: uuid("primary_cta_id"),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    // FLAG: closed set from §B2 "proposed", DB-enforced via CHECK — see header.
    status: text("status").notNull().default("draft"),
    successMetricsJson: jsonb("success_metrics_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // §B2: minor units (cents), nullable. Reconciled from P1 `budget_cents`.
    // FLAG.
    budgetAmount: integer("budget_amount"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceIdIdx: index("campaign_workspace_id_idx").on(table.workspaceId),
    productIdIdx: index("campaign_product_id_idx").on(table.productId),
    // §B2 status lifecycle (proposed); DB-enforced via CHECK while the
    // vocabulary is young (mirrors objection_record/enrollment_action_recommendation).
    statusValid: check(
      "campaign_status_valid",
      sql`${table.status} IN ('draft', 'active', 'paused', 'complete')`,
    ),
  }),
);
