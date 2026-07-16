# Canonical Patch Set 01 — Corrections & Multi-Product Upgrade

**Status:** AUTHORITATIVE. This document **supersedes** the specific spec sections cited below. Where this patch set and an original spec section conflict, this patch set wins.
**Date:** 2026-07-16 · **Provenance:** verified findings in [`../planning/BUILD_READINESS_AND_LOOP_PLAN.md`](../planning/BUILD_READINESS_AND_LOOP_PLAN.md) §2–§3 (3 reviewers → 2 adversarial verifiers) + ADR-09.
**Scope:** 2 blockers (B1–B2), 1 architecture upgrade (B0), and 12 confirmed defects (C/D/E/F/S). Enum values marked *(proposed)* are conventions awaiting a rubber-stamp; nothing here invents business facts.

File key: **P0** = `FOS_Phase_0_...md` · **DEP** = `00_FOS_Next_Dependencies_...md` · **P1..P6** = `0N_FOS_Phase_*.md`.

---

## B0 — Multi-product tenancy & product hierarchy (ADR-09)
**Supersedes:** P0 §9 (adds entity), and adds a `product_id` column to the entities listed. **Adds** the founder-level vs product-scoped taxonomy.

### New entity: `Product` (self-referential tree)
| field | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid FK → FOSWorkspace | canonical FOS tenant |
| `parent_product_id` | uuid FK → Product, **nullable** | NULL = top-level peer product; set = sub-offering |
| `product_key` | text, unique per workspace | stable slug |
| `name` | text | |
| `product_type` | enum: `product` \| `sub_offering` | must equal `product` iff `parent_product_id` IS NULL |
| `status` | enum: `active` \| `paused` \| `retired` | |
| `created_at` / `updated_at` | timestamptz | |

**Invariant:** `parent_product_id` may reference only a Product in the same `workspace_id`. Depth is unbounded by schema; today only 2 levels are used.

### Scoping taxonomy
- **Founder-level (NO `product_id`):** `Person`, `EvidenceItem`, founder-voice records, `DecisionRecord`, `OperatingReview`, `FOSWorkspace`.
- **Product-scoped (add `product_id` uuid FK → Product, NOT NULL unless noted):** `Offer`, `Program`, `Cohort`, `EnrollmentOpportunity`, `Campaign`, `AudienceSegment`, `ProductCapability`, `ProductClaim`, `ContentAsset`, `ProductSignal`.
- **Event envelope:** `OperationalEvent` gains `product_id` uuid **nullable** (see S1).
- **Authorization:** every product-scoped read/command adds a `product_id` filter to the P0 §7.5 checks.
- **Deferred (YAGNI until a real sub-offering exists):** recursive roll-up queries across a product + its sub-offerings; product-switch UI; per-product dashboards.

---

## B1 — `Offer` / `Program` / `Cohort` entities (blocker; fixes dangling `offer_id`)
**Supersedes:** P0 §9 (adds entities); P0 §14.6 pricing-validation gate now has a data model.

### `Offer` (product-scoped)
| field | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `product_id` | uuid FK → Product | B0 |
| `offer_key` | text, unique per product | |
| `name` | text | |
| `program_id` | uuid FK → Program, nullable | |
| `cohort_id` | uuid FK → Cohort, nullable | |
| `price_amount` | integer (minor units) | e.g. cents |
| `currency` | text (ISO-4217) | |
| `billing_period` | enum: `one_time` \| `monthly` \| `annual` *(proposed)* | |
| `availability_start` / `availability_end` | timestamptz, nullable | |
| `status` | enum: `draft` \| `approved` \| `active` \| `retired` *(proposed)* | pricing gate requires `approved`+`active` |
| `approved_by` | uuid FK → user, nullable | |
| `approved_at` | timestamptz, nullable | |
| `created_at` / `updated_at` | timestamptz | |

`Program` = `{id, product_id, program_key, name, status}`; `Cohort` = `{id, program_id, cohort_key, name, starts_at, ends_at, status}` (minimal; extend when needed).
**Wiring:** `EnrollmentOpportunity.offer_code` (P0 §9.4) is **replaced** by `offer_id` uuid FK → Offer (nullable until an offer is selected). `Campaign.offer_id` (see B2) references the same. Pricing validation (P0 §14.6 step 6) reads `Offer.price_amount/currency/status`.

---

## B2 — Single canonical `Campaign` (blocker; resolves the double definition)
**Supersedes:** P1 §6.2. **Authoritative definition lives in P0 §10.7**, amended to:

| field | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `product_id` | uuid FK → Product | B0 |
| `campaign_key` | text | |
| `objective` | text | |
| `offer_id` | uuid FK → Offer, nullable | (was `offer_code` string) |
| `audience_segment_ids` | uuid[] | |
| `narrative_ids` / `content_pillar_ids` / `channel_ids` / `secondary_cta_ids` | uuid[] | (replaces `channel_plan_json`) |
| `budget_amount` | integer (minor units), nullable | (was `budget_cents`; unit-consistent with Offer) |
| `status` | enum: `draft` \| `active` \| `paused` \| `complete` *(proposed)* | |
| `created_at` / `updated_at` | timestamptz | |

**P1 §6.2 is rewritten as a delta:** "Campaign is defined canonically in P0 §10.7 (as amended by Patch Set 01 B2). Phase 1 adds **no** new Campaign fields." This restores P0 §3.3 success condition 13.

---

## C1 — Notion projection hidden-property contract (fixes day-one template failure)
**Supersedes:** the P1–P6 shared "required hidden properties" block **and** P0 §13 templates. One reconciled set on **every** projected page:
- `FOS Record ID` (canonical entity id) — *standardized name; replaces per-entity `Opportunity ID`/`Content ID`/etc.*
- `FOS Workspace ID`
- `FOS Product ID` *(new; nullable for founder-level projections — B0)*
- `Sync Status` — **canonical name; `Projection Status` is retired.**
- `FOS Version` (see C2)
- `Last Synced At`

P0 §13 database templates and the P1–P6 shared block are both updated to this exact list.

## C2 — `FOS Version` derivation (fixes the unspecified conflict-check target)
**Supersedes:** the P1–P6 conflict rule. Definition, per entity type:
- **Artifact projections:** `FOS Version` = `ArtifactVersion.version_number` of the record's `current_version_id`.
- **Versioned entities** (EnrollmentOpportunity, AgentDefinition, ProjectionPolicy): `FOS Version` = that entity's `version`.
- A controlled command executes only if the provider's `FOS Version` equals the current canonical value; otherwise → `conflict` (E1).

## C3 — Projection-policy example correction
**Supersedes:** P0 §8.2 worked example. The `ArtifactRecord` policy example must use real fields: `ArtifactRecord.status` + `ArtifactVersion.body_markdown` / `.approval_status` / `.claims_manifest_json`, and policy keys `field_policy_json` + `requires_approval` (matching the §11.3 schema). State explicitly: **artifact projection policies span record-level and current-version fields.**

---

## D1 — Minimal canonical `ProductSignal` & `OperatingReview` in Phase 0
**Supersedes:** P0 §9 (adds two entities), satisfying P0 §13.6/§13.8 projections + the `register_product_signal` command (NEW-1).
- `ProductSignal` (product-scoped) = `{id, product_id, signal_key, source, summary, status, created_at}` — P3 extends, does not redefine.
- `OperatingReview` (founder-level) = `{id, workspace_id, period_start, period_end, status, created_at}` — P6 extends.

## D2 — `CampaignTouch.content_asset_id` forward-reference
**Supersedes:** P1 §6.3. Change the FK to **`artifact_record_id`** uuid FK → ArtifactRecord (which exists in P0). P4 layers `ContentAsset` as a specialized view over `ArtifactRecord` without changing this column.

---

## E1 — `WorkspaceCommand` status model (single source of truth)
**Supersedes:** P0 §11.5 fields + reconciles with §12.3. Replace the two fields (`validation_status`, `execution_status`) with a **single `status`** enum matching the §12.3 machine: `received` → `validating` → `validated` → `queued` → `executing` → `succeeded` \| `failed_retryable` \| `failed_terminal`, with `conflict` reachable from `validating`. Add events `workspace_command.queued` and `workspace_command.failed` (S1).

## E2 — Artifact status carrier (declare the one owner)
**Supersedes:** ambiguity across P0 §12.2 / §9.12 / §9.13 / §9.14. Declaration:
- `ArtifactVersion.approval_status` is the **authoritative lifecycle carrier** for a version (`draft` → `in_review` → `approved` → `ready_for_action` → `executed`).
- `ArtifactRecord.status` is a **derived** convenience mirror of the current version's status (documented as derived; never written independently).
- `Approval.status` records a **decision** on a specific version, not the artifact's lifecycle state. The lifecycle transition is a consequence of the decision.

## E3 — Canonical command-type enum
**Supersedes:** DEP §3.2 naming. **P0 §11.5 names win.** Crosswalk (DEP → canonical): `approve_with_edits`→`approve_artifact_with_edits`; `propose_stage_transition`→`propose_opportunity_stage_change`; `create_external_draft`→`create_email_draft`; `run_agent`→`run_agent_when_enabled`; `resolve_conflict`→`resolve_sync_conflict`. `run_test_suite` / `create_issue` / `record_publication` are **Phase 3/4 enum extensions**, not Phase 0.

## E4 — Canonical artifact-type enum
**Supersedes:** the divergent lists in P0 §9.12, P1, P2. Canonical keys (P0 owns the enum); phases must use these exact strings:
`enrollment_message` · `call_brief` · `research_brief` · … (full list maintained in P0 §9.12 as amended). Crosswalk of retired aliases: `enrollment_brief`→`enrollment_message`; `call_preparation_brief`→`call_brief`; `substack_research_brief`→`research_brief`. Migration maps any legacy value through this table.

## E5 — Gate identifier disambiguation
**Supersedes:** the clashing A–D letters. **P0 §22 rollout gates** are renamed `R-A`…`R-D` (Canonical / Projection / Edit / Command safety). **DEP §7 cross-phase gates** are renamed `G1`…`G6`. "Gate B" is no longer ambiguous.

## F1 — Founder-edit entity (resolve the duplicate)
**Supersedes:** P0 §9.15 + §11.7. Keep **one** entity, `FounderWorkspaceEdit` (§11.7 fields: `base_artifact_version_id`, `new_artifact_version_id`, `projection_id`, `provider_record_id`, `original_snapshot_json`, `edited_snapshot_json`, `diff_json`, `edit_categories_json`, `edit_distance`, `captured_at`). `source_interface` + `founder_reason` from §9.15 migrate onto it as nullable columns. **Delete `FounderEdit` (§9.15).** §14.5 already writes only `FounderWorkspaceEdit`.

---

## S1 — Event schema registry (envelope + per-type)
**Supersedes:** P0 §9.7 generic `payload_json`. Adds a machine-readable registry (implemented as Zod schemas, one per event type, checked into `packages/contracts` at build time). Common envelope on every event:
```
{ id, workspace_id, product_id?, correlation_id, causation_id, occurred_at, actor: {type, id}, type, payload }
```
`payload` is validated by the per-`type` schema. New types added by E1: `workspace_command.queued`, `workspace_command.failed`.

## S2 — Conventions addendum: open enum value sets *(proposed — approve once)*
**Supersedes:** the unspecified value sets in P0 §9. Proposed canonical values:
- `Person.privacy_classification`: `standard` \| `sensitive` \| `restricted`
- `EvidenceItem.confidence`: `low` \| `medium` \| `high`
- `EvidenceItem.verification_status`: `unverified` \| `founder_verified` \| `evidence_backed`
- `EvidenceItem.permitted_use`: `internal_only` \| `marketing_with_attribution` \| `public`
- `Approval.risk_level` & `WorkspaceCommand.risk_level`: `low` \| `medium` \| `high`
- `FounderTask.priority`: `low` \| `medium` \| `high` \| `urgent`; `.status`: `open` \| `in_progress` \| `blocked` \| `done`; `.task_type`: `review` \| `decision` \| `content` \| `ops` *(proposed)*
- `DecisionRecord.status`: `open` \| `decided` \| `revisited`; `.decision_type`: `strategic` \| `product` \| `pricing` \| `ops` *(proposed)*
- `AgentDefinition.max_autonomy_level`: `L1` \| `L2` \| `L3` \| `L4` (bound to the design-system autonomy ladder)
- `ArtifactRecord.domain`: `enrollment` \| `editorial` \| `release` \| `marketing` \| `research` *(proposed)*

## S3 — Idempotency / hashing / diff derivation rules
**Supersedes:** the underived fields in P0 §11.4/§11.5/§9.15. Canonical rules:
- `idempotency_key` = `SHA-256(integration_id + ':' + provider_event_id + ':' + command_type)`
- `content_hash` = `SHA-256(normalized_markdown)` where normalization = trim trailing whitespace, LF line endings, single trailing newline (the supported-subset normalizer, see S4-adjacent fidelity note)
- `diff_json` = unified diff over normalized markdown
- `edit_distance` = token-level Levenshtein
- `edit_categories` taxonomy *(proposed)*: `shorten` \| `expand` \| `claim_removal` \| `tone` \| `factual_correction` \| `restructure`

## S4 — `Asset` entity
**Supersedes:** the dangling `*_asset_id` fields (P0 §9.3/§9.5). Add `Asset` = `{id, workspace_id, product_id?, storage_ref, mime_type, byte_size, sensitivity, content_hash, created_at}`. `evidence_asset_id` / `resume_asset_id` / `linkedin_snapshot_asset_id` become FKs → Asset (nullable). Blob store per ADR-04 (host object storage); the entity is canonical, the bytes are external.

---

## Not changed (verified as consistent or intended)
Per the adversarial verification, these were **refuted** as issues and are deliberately left alone: authorization model (P0 §7.5 is specified), webhook capture mechanism (specified; Notion limits handled by ADR-06 spike), secret store (host reuse), `enrollment.*` events (intended additive per DEP §3.5), and the master-vs-canonical "contradictions" (stale-by-design; master is archived, not in this repo).
