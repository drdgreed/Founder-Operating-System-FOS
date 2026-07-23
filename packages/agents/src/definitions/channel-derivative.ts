import { z } from "zod";
import { claimsInApprovedSetGate } from "../gates/claims-in-approved-set.js";
import { featureModeAllowedGate } from "../gates/feature-mode-allowed.js";
import type { Gate } from "../gates/gate.js";
import type { AgentDefinition } from "../types.js";
// REUSE the editorial agent's CLOSED channel + asset-type enums (P1.7a, spec
// §8.7): a derivative targets ONE of the SAME five launch channels and ONE of
// the SAME already-canonical downstream asset types the plan enumerated — there
// is no reason to fork a second vocabulary (DRY). CAMPAIGN_ASSET_TYPES is
// declared `satisfies ArtifactType[]` at its source, so routing the artifact to
// `assetSpec.assetType` (below) is guaranteed to land on a canonical enum member.
import { CAMPAIGN_ASSET_TYPES, CAMPAIGN_CHANNELS } from "./beta-launch-editorial.js";

/**
 * `fos.channel_derivative` (issue #111, spec §9.4 step 4) — the Channel
 * Derivative Agent, which COMPLETES WP1.7. Spec §9.4 step 4: "Derivative
 * artifacts are generated and independently verified." Given the Substack
 * Cornerstone ANCHOR (§8.8 / §9.4 step 3 / P1.7b) plus ONE planned asset spec
 * from the Editorial plan (§8.7 / §9.4 step 2 / P1.7a — a channel + asset type +
 * title + purpose) and the campaign context, it produces the CHANNEL-SPECIFIC
 * derivative artifact (a LinkedIn post, a carousel script, an email sequence, a
 * newsletter, landing-page copy, a webinar package, or a derivative Substack
 * paper). It fans the anchor OUT; it may NOT publish.
 *
 * SCOPE (mirrors P1.7a/P1.7b's boundary): this builds ONLY the agent definition
 * on the existing 12-stage runtime — it produces ONE derivative artifact, of the
 * TYPE the input asset spec names, for founder review. It does NOT build the
 * campaign workflow orchestration/queueing that fans a plan out into N
 * derivative runs (§9.4), the "independent verification" of a derivative against
 * its anchor (§9.4 step 4 / §11 — a separate verifier slice), or any publish
 * path. One spec in, one derivative out.
 *
 * MAY-NOT-PUBLISH INVARIANT (spec §8.7/§8.8 sibling posture, §12 "External send
 * and publication remain separate explicit actions"). IDENTICAL construction to
 * the editorial + cornerstone agents, defense in depth:
 *   1. `permittedTools: []` — no publish/HTTP/command capability exists.
 *   2. `autonomyCeiling: "review"` + `featureModeAllowedGate` allow ONLY
 *      `shadow`/`review` — `live` (the reserved would-be-execution mode) is
 *      blocked both by the ceiling (mode.ts `effectiveMode` caps it) AND by
 *      the gate re-check. There is no publish path in ANY mode regardless.
 *   3. NO `projection` hook — the ONLY external-side-effect seam the runtime
 *      offers (stage 11) is absent, so nothing external is ever invoked.
 *   4. The created derivative artifact is routed to a PRE-PUBLICATION approval
 *      state ONLY: `draft` in shadow mode, `in_review` in review mode (stage 10)
 *      — NEVER `approved`/`ready_for_action`/`executed`, and the runtime never
 *      auto-decides an approval (a founder action). Publication is a later,
 *      separate, explicit `Mark artifact published` command (§7.3).
 * NOTE the artifact TYPE is a real publishable asset type (`linkedin_post`,
 * `email_sequence`, …) — like the cornerstone's `substack_paper`, NOT the
 * editorial plan's `internal_note` stopgap. That is correct: a derivative IS a
 * channel asset. "May not publish" is enforced by the lifecycle STATE
 * (draft/in_review) + the four defenses above, NOT by using a non-publishable
 * artifact type. Creating a draft derivative is exactly §9.4 step 4; publishing
 * it is §9.4 step 7.
 *
 * ARTIFACT-ONLY, NO OWNERSHIP SEAM (same as the editorial + cornerstone agents):
 * there is no `persistDomain`. Spec §6 defines no Campaign/Asset domain entity,
 * so there is no domain record to write and no caller-supplied opportunity id to
 * re-assert. The cornerstone anchor + asset spec are taken as least-privilege
 * INLINE content the model reasons over (UNTRUSTED — §12 posture); their refs
 * are carried for provenance but are NOT dereferenced from the DB in this slice,
 * so there is no confused-deputy cross-workspace read to guard here. The
 * derivative artifact is created under `runContext.workspaceId` by the runtime.
 *
 * FLAG (issue #111, §6 gap): no seeded Campaign entity, no cornerstone/asset-plan
 * dereference, and no ownership assertion — dereferencing the anchor artifact
 * (+ its workspace-ownership check) and joining the derivative to a canonical
 * Campaign/AssetPlan row belong to the campaign-workflow slice (§9.4), not this
 * agent-definition slice. `cornerstone.content`, `assetSpec`, and
 * `approvedClaims` are least-privilege caller-provided input (the same
 * convention every prior P1 agent used for its un-seeded registries), never
 * live lookups.
 *
 * FLAG (issue #111, §S2 domain gap): `ArtifactSpec.domain` is STATIC (not a
 * per-run function like `artifactType`), yet a derivative's most natural domain
 * varies by asset type (a `substack_paper` derivative is "editorial"; every
 * other channel is "marketing"). The dominant derivative case is the marketing
 * channels (LinkedIn/email/newsletter/landing/webinar), so the domain is fixed
 * to `"marketing"` — the "Beta Launch Campaign" §7.2 collection. Making domain a
 * per-run function is out of this slice's boundary (a type change on the shared
 * `ArtifactSpec`); the mismatch is cosmetic (collection grouping), not a
 * security property.
 *
 * SECURITY-SENSITIVE (ADR-07 D7/D9): the model writes; the deterministic gates
 * enforce. Untrusted anchor content reaches the model ONLY via
 * `cornerstone.content` (opaque data) — the gates only ever see the Zod-
 * validated `input`/`output`, never raw text, so injected content can change
 * what the model WRITES but never what the GATES, MODE, or APPROVAL routing
 * decide. In particular the artifact TYPE is routed from the (Zod-enum-
 * validated) INPUT `assetSpec.assetType`, and the channel-consistency gate
 * (below) proves the model's produced content actually declares itself as that
 * commissioned channel/type — so injected content can never redirect the
 * derivative to a different asset type than the one the founder commissioned.
 */

// ---- Input (stage 1/3): least-privilege anchor + asset spec + context ------

export const channelDerivativeInputSchema = z.object({
  campaign: z.object({
    /** Provenance id for the campaign this derivative belongs to (NOT
     * dereferenced in this slice — see file header FLAG). */
    id: z.string().uuid(),
    /** The campaign's objective (context the model writes toward). */
    objective: z.string().min(1),
    /** The target audience description. */
    audience: z.string().min(1),
    /** The offer being launched. */
    offer: z.string().min(1),
  }),
  /** The Substack CORNERSTONE anchor (§8.8 / P1.7b) this derivative is drawn
   * from. */
  cornerstone: z.object({
    /** Provenance ref to the `substack_paper` cornerstone artifact (§7.1).
     * Carried for audit; NOT dereferenced from the DB in this slice (FLAG). */
    artifactRef: z.string().min(1),
    /** The approved cornerstone content the model reasons over. UNTRUSTED (spec
     * §12 posture): passed as data, NEVER interpreted as instructions. */
    content: z.string().min(1),
  }),
  /** ONE planned asset spec from the Editorial plan (§8.7 / P1.7a): the channel,
   * the downstream asset type, the working title, and the purpose the founder
   * approved for THIS derivative. `channel`/`assetType` are CLOSED enums; the
   * artifact type is routed from `assetType` and the produced content is gated to
   * match this spec (`channel-type-consistent` gate below). `title`/`purpose`
   * are least-privilege caller input (they originate from an already-compliance-
   * reviewed plan artifact), rendered as CONTEXT, not model output. */
  assetSpec: z.object({
    channel: z.enum(CAMPAIGN_CHANNELS),
    assetType: z.enum(CAMPAIGN_ASSET_TYPES),
    title: z.string().min(1),
    purpose: z.string().min(1),
  }),
  /** The founder-approved claim allowlist for THIS campaign/offer — every claim
   * the derivative's `claimsManifest` asserts MUST be in this set
   * (`claims-in-approved-set` gate). A derivative may only AMPLIFY claims already
   * approved for the cornerstone, never introduce a new one. FLAG (issue #82
   * precedent): least-privilege caller input, not a live claims-registry lookup
   * (that registry is P1.8). */
  approvedClaims: z.array(z.string().min(1)),
});

export type ChannelDerivativeInput = z.infer<typeof channelDerivativeInputSchema>;

// ---- Output (stage 6): the channel-specific derivative (spec §9.4 step 4) ---

export const channelDerivativeOutputSchema = z.object({
  /** The channel this derivative is FOR — a CLOSED enum. STRUCTURAL: the
   * `channel-type-consistent` gate proves it EQUALS `input.assetSpec.channel`,
   * so the model can never produce content for a channel other than the one the
   * founder commissioned. */
  channel: z.enum(CAMPAIGN_CHANNELS),
  /** The downstream asset type this derivative IS — a CLOSED enum. STRUCTURAL:
   * the `channel-type-consistent` gate proves it EQUALS `input.assetSpec.assetType`
   * (the same value the artifact is routed to), so the persisted artifact type
   * always matches the content the model actually produced. */
  assetType: z.enum(CAMPAIGN_ASSET_TYPES),
  /** The channel-appropriate opener (a LinkedIn hook, an email subject line, a
   * landing-page headline …). Model free text — SCANNED. */
  hook: z.string().min(1),
  /** The channel-appropriate body copy. Model free text — SCANNED. */
  body: z.string().min(1),
  /** The primary call-to-action. Model free text — SCANNED. */
  cta: z.string().min(1),
  /** Every substantive claim this derivative makes — each MUST be in the
   * founder-approved `approvedClaims` set (`claimsInApprovedSetGate`). The model
   * can never assert an unapproved claim, so these are gate-validated closed
   * values, NOT a free-text scan surface. May be empty (a pure-hook asset need
   * assert no claim). */
  claimsManifest: z.array(z.string().min(1)),
});

export type ChannelDerivativeOutput = z.infer<typeof channelDerivativeOutputSchema>;

/**
 * Deterministic channel/type-consistency gate: the derivative the model produced
 * MUST declare the SAME channel and asset type the founder commissioned in
 * `input.assetSpec`. This is what makes the `artifactType` routing (which reads
 * `input.assetSpec.assetType`) SOUND — without it the model could emit LinkedIn
 * copy while the artifact was persisted as, say, an `email_sequence`. Local to
 * this agent (a one-off invariant, not a reusable library gate), so it is a plain
 * `Gate` object rather than a gate factory. Reads only the Zod-validated
 * `input`/`output` (D9): not steerable by untrusted anchor content.
 */
export const channelTypeConsistentGate: Gate<ChannelDerivativeInput, ChannelDerivativeOutput> = {
  key: "fos.channel_derivative.channel-type-consistent",
  evaluate: ({ input, output }) => {
    if (output.channel !== input.assetSpec.channel) {
      return {
        allowed: false,
        reason: `derivative channel "${output.channel}" does not match the commissioned asset spec channel "${input.assetSpec.channel}"`,
      };
    }
    if (output.assetType !== input.assetSpec.assetType) {
      return {
        allowed: false,
        reason: `derivative assetType "${output.assetType}" does not match the commissioned asset spec assetType "${input.assetSpec.assetType}"`,
      };
    }
    return { allowed: true };
  },
};

// ---- Definition ------------------------------------------------------------

export const FOS_CHANNEL_DERIVATIVE_AGENT_KEY = "fos.channel_derivative";
export const FOS_CHANNEL_DERIVATIVE_FEATURE_FLAG_KEY = "fos.channel_derivative";

export const fosChannelDerivativeAgentDefinition: AgentDefinition<
  ChannelDerivativeInput,
  ChannelDerivativeOutput
> = {
  key: FOS_CHANNEL_DERIVATIVE_AGENT_KEY,
  version: "1.0.0",
  objective:
    "Given a Substack cornerstone anchor, ONE planned asset spec (a channel, a downstream asset " +
    "type, a working title, and a purpose) from the campaign's editorial plan, the campaign " +
    "context, and the founder-approved claim set, produce the CHANNEL-SPECIFIC derivative for " +
    "that asset: a channel-appropriate hook, body copy, a primary call-to-action, and a claims " +
    "manifest drawn only from the approved claim set. Produce the derivative for exactly the " +
    "commissioned channel and asset type, and assert only approved claims. This CREATES a draft " +
    "derivative artifact for founder review — it NEVER publishes — and NEVER guarantees an " +
    "employment, recruiter, salary, or interview outcome.",
  inputSchema: channelDerivativeInputSchema,
  outputSchema: channelDerivativeOutputSchema,
  // NO tools: no publish/command/HTTP capability by construction (may-not-
  // publish invariant, file header point 1).
  permittedTools: [],
  permittedMemoryScopes: ["campaign", "substack_paper"],
  autonomyCeiling: "review",
  featureFlagKey: FOS_CHANNEL_DERIVATIVE_FEATURE_FLAG_KEY,
  deterministicGates: [
    featureModeAllowedGate({
      key: "fos.channel_derivative.mode-allowed",
      // shadow/review ONLY — `live` (would-be execution) is never permitted
      // (may-not-publish invariant, file header point 2).
      allowedModes: ["shadow", "review"],
    }),
    // The derivative's produced channel + asset type MUST match the commissioned
    // asset spec — the model can never redirect the derivative to a different
    // channel/type than the founder approved, and this keeps the `artifactType`
    // routing (which reads `input.assetSpec.assetType`) sound.
    channelTypeConsistentGate,
    // Every claim in the manifest must be in the founder-approved set — a
    // derivative can only AMPLIFY pre-approved claims, never introduce one
    // (REUSE of the personalized-follow-up / substack / issue #82 gate).
    claimsInApprovedSetGate<ChannelDerivativeInput, ChannelDerivativeOutput>({
      key: "fos.channel_derivative.claims-in-approved-set",
      selectClaims: (output) => output.claimsManifest,
      selectApprovedClaims: (input) => input.approvedClaims,
    }),
    // ============================================================
    // MECHANICAL guarantee-scan classification (AGENT_LESSONS P-004).
    // EVERY value `buildBodyMarkdown`/`buildClaimsManifest` renders or
    // persists, classified as exactly one of:
    //   (i)   input-derived (not model output)
    //   (ii)  a closed Zod enum
    //   (iii) gate-validated against a set (an earlier-ordered gate above)
    //   (iv)  SCANNED by complianceReviewText below
    // Re-run this enumeration on ANY change to the output schema,
    // `buildBodyMarkdown`, `buildClaimsManifest`, OR a gate's coverage. A
    // model-authored rendered/persisted value that is none of (i)-(iv) is a
    // guarantee leak.
    //
    //   input.campaign.objective/audience/offer → (i) input-derived
    //   input.cornerstone.artifactRef           → (i) input-derived (ref only)
    //   input.cornerstone.content               → (i) input-derived (untrusted
    //                                              data; NOT rendered raw)
    //   input.assetSpec.channel                 → (i) input-derived + (ii) closed
    //                                              enum CAMPAIGN_CHANNELS
    //   input.assetSpec.assetType               → (i) input-derived + (ii) closed
    //                                              enum CAMPAIGN_ASSET_TYPES
    //   input.assetSpec.title                   → (i) input-derived (from an
    //                                              already-compliance-reviewed plan)
    //   input.assetSpec.purpose                 → (i) input-derived (as above)
    //   output.channel                          → (ii) closed enum CAMPAIGN_CHANNELS
    //                                              + (iii) channel-type-consistent gate
    //   output.assetType                        → (ii) closed enum CAMPAIGN_ASSET_TYPES
    //                                              + (iii) channel-type-consistent gate
    //   output.hook                             → (iv) SCANNED
    //   output.body                             → (iv) SCANNED
    //   output.cta                              → (iv) SCANNED
    //   output.claimsManifest[]                 → (iii) gate-validated
    //                                              (claims-in-approved-set: each ==s
    //                                              a founder-approved, pre-vetted
    //                                              claim string — the same not-a-
    //                                              scan-surface reasoning as the
    //                                              cornerstone's manifest)
    // `buildClaimsManifest` persists ONLY: channel/assetType (ii closed enum) +
    // claimsManifest (iii gate-validated) — no NEW model free-text sink beyond
    // what is already scanned above.
    // ============================================================
  ],
  // Stage-7b semantic compliance review (Option C slice 2, issue #109) — the
  // eval-validated guarantee classifier replaces the removed keyword gate. Same
  // fields the old gate's `selectText` scanned (see the mechanical enumeration
  // above) — keep in sync with `buildBodyMarkdown`.
  complianceReviewText: (output) => [output.hook, output.body, output.cta],
  artifact: {
    // The artifact type is ROUTED from the (Zod-enum-validated) INPUT asset spec
    // — a derivative BECOMES the downstream type its plan entry named. Expressed
    // via the function form of `ArtifactSpec.artifactType` (personalized-follow-up
    // precedent) so the type varies per run; `CAMPAIGN_ASSET_TYPES satisfies
    // ArtifactType[]` (at its source) guarantees the return value is always a
    // canonical enum member, and `channelTypeConsistentGate` proves the produced
    // content declares this same type. `domain: "marketing"` (see file header
    // FLAG on why domain is static "marketing" even for a substack_paper
    // derivative). NO enum value added (slice boundary).
    artifactType: (input) => input.assetSpec.assetType,
    domain: "marketing",
    buildTitle: (input) =>
      `Derivative (${input.assetSpec.channel} / ${input.assetSpec.assetType}): ${input.assetSpec.title}`,
    buildBodyMarkdown: (input, output) =>
      [
        `# Channel Derivative: ${input.assetSpec.title}`,
        "",
        `**Channel:** ${input.assetSpec.channel}`,
        `**Asset type:** ${input.assetSpec.assetType}`,
        `**Campaign objective:** ${input.campaign.objective}`,
        `**Audience:** ${input.campaign.audience}`,
        `**Offer:** ${input.campaign.offer}`,
        `**Cornerstone anchor:** ${input.cornerstone.artifactRef}`,
        `**Purpose:** ${input.assetSpec.purpose}`,
        "",
        "## Hook",
        output.hook,
        "",
        "## Body",
        output.body,
        "",
        `**Primary CTA:** ${output.cta}`,
        "",
        "## Claims referenced",
        ...(output.claimsManifest.length ? output.claimsManifest.map((c) => `- ${c}`) : ["- none"]),
      ].join("\n"),
    buildClaimsManifest: (_input, output) => {
      // Internal audit aid: the channel + asset type this derivative targets
      // (closed enums, gate-validated to match the commissioned spec) and the
      // exact approved claims it asserted (gate-validated), so a reviewer can
      // spot-check the derivative without re-deriving it. ONLY closed-enum +
      // gate-validated values are persisted here (no new model free-text sink).
      return {
        channel: output.channel,
        assetType: output.assetType,
        claims: output.claimsManifest,
      };
    },
  },
  // NO `persistDomain` (no domain entity, no opportunity to own — file header)
  // and NO `projection` (no external side effect / no publish path — may-not-
  // publish invariant, file header point 3).
};
