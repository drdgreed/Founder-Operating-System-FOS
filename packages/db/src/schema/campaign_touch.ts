import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { campaign } from "./campaign.js";
import { person } from "./person.js";
import { enrollmentOpportunity } from "./enrollment_opportunity.js";
import { artifactRecord } from "./artifact_record.js";

/**
 * CampaignTouch (spec §6.3, amended by PATCH-SET-01 §D2; issue #91 P1.6) — an
 * APPEND-ONLY campaign touchpoint / attribution event. Schema + migration only
 * in this slice — no agent/API/projection wiring.
 *
 * APPEND-ONLY: a touch is an immutable historical fact, so — unlike the mutable
 * lifecycle records (objection_record, enrollment_action_recommendation) — it
 * carries NO `version` and NO `updated_at`; only `created_at`. (No hard
 * no-UPDATE/no-DELETE DB trigger is added: the record has no mutable columns to
 * guard, and the slice brief scopes append-only to the column shape. FLAG — a
 * trigger like operational_event's can be added if a future slice needs it.)
 *
 * - `campaign_id` FK NOT NULL -> campaign (spec §6.3; every touch belongs to a
 *   campaign).
 * - `person_id` FK NULLABLE -> person: a touch may be pre-identity (an
 *   anonymous impression/click) before a person is resolved.
 * - `opportunity_id` FK NULLABLE -> enrollment_opportunity: a touch may precede
 *   any opportunity (top-of-funnel), or be attributed to one later.
 * - `artifact_record_id` FK NULLABLE -> artifact_record: §D2 REPLACES P1
 *   §6.3's forward-referencing `content_asset_id` with `artifact_record_id`
 *   (ArtifactRecord exists in P0; P4 later layers `ContentAsset` as a view over
 *   it without changing this column). Nullable — not every touch cites an
 *   artifact.
 * - `cta_id`: uuid nullable, NO FK yet (CTA registry is a later slice; mirrors
 *   campaign.primary_cta_id). FLAG.
 * - `publication_reference`, `channel`, `touch_type`, `referrer`,
 *   `confidence`: spec §6.3 gives no enums/types. Modeled as open `text`
 *   (minimal-defensible-type convention, mirrors
 *   enrollment_assessment.fit_confidence / objection_record.confidence). FLAG,
 *   no closed set is evident for any of them.
 * - `utm_json`: jsonb container defaulting to `{}` (mirrors the `*_json`
 *   convention).
 * - `occurred_at`: nullable timestamptz — the event-time of the touch (distinct
 *   from `created_at`, the record-write time).
 */
export const campaignTouch = pgTable(
  "campaign_touch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaign.id),
    personId: uuid("person_id").references(() => person.id),
    opportunityId: uuid("opportunity_id").references(() => enrollmentOpportunity.id),
    // §D2: replaces P1 §6.3 `content_asset_id`. Nullable FK -> artifact_record.
    artifactRecordId: uuid("artifact_record_id").references(() => artifactRecord.id),
    publicationReference: text("publication_reference"),
    channel: text("channel"),
    // uuid nullable, no FK yet (CTA registry is a later slice). FLAG.
    ctaId: uuid("cta_id"),
    touchType: text("touch_type"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    utmJson: jsonb("utm_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    referrer: text("referrer"),
    // FLAG: no enum in spec — see header note.
    confidence: text("confidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    campaignIdIdx: index("campaign_touch_campaign_id_idx").on(table.campaignId),
    personIdIdx: index("campaign_touch_person_id_idx").on(table.personId),
    opportunityIdIdx: index("campaign_touch_opportunity_id_idx").on(table.opportunityId),
    artifactRecordIdIdx: index("campaign_touch_artifact_record_id_idx").on(table.artifactRecordId),
  }),
);
