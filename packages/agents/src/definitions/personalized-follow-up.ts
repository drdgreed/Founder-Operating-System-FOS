import { eq } from "drizzle-orm";
import { z } from "zod";
import { enrollmentOpportunity } from "@fos/db/schema";
import type { ArtifactType } from "@fos/db/schema";
import type { Db } from "@fos/db/services";
import { claimsInApprovedSetGate } from "../gates/claims-in-approved-set.js";
import { consentGate } from "../gates/consent.js";
import { factsResolveToSourcesGate } from "../gates/facts-resolve-to-sources.js";
import { featureModeAllowedGate } from "../gates/feature-mode-allowed.js";
import { recommendedPathwayAvailableGate } from "../gates/recommended-pathway-available.js";
import type { AgentDefinition } from "../types.js";

/**
 * Re-reads the target opportunity and asserts it belongs to this run's
 * workspace, mirroring `loadOwnedOpportunity` in `call-preparation.ts` /
 * `next-best-action.ts` / `objection-intelligence.ts` (issue #82, same
 * rationale those files gave for not importing from one another): never trust
 * a caller-supplied `opportunity.id` across the workspace boundary. Small,
 * intentional per-file duplication of the pattern rather than a cross-agent
 * dependency.
 */
async function loadOwnedOpportunity(db: Db, opportunityId: string, workspaceId: string) {
  const [row] = await db
    .select()
    .from(enrollmentOpportunity)
    .where(eq(enrollmentOpportunity.id, opportunityId))
    .limit(1);
  if (!row) {
    throw new Error(
      `fos.personalized_follow_up: enrollment_opportunity ${opportunityId} not found`,
    );
  }
  if (row.workspaceId !== workspaceId) {
    throw new Error(
      `fos.personalized_follow_up: opportunity ${opportunityId} is not in workspace ${workspaceId}`,
    );
  }
  return row;
}

/**
 * `fos.personalized_follow_up` (issue #82, spec §8.4) — the fourth P1.4
 * sub-slice (§9.2 step 5 "create follow-up artifact"). The FIRST agent that
 * drafts EXTERNAL, applicant-facing content — a channel-specific follow-up
 * message — so the guarantee/claims/consent discipline is at its HIGHEST
 * stakes. Like `call-preparation.ts`, this is an ARTIFACT-ONLY agent: spec §7.1
 * gives it no domain entity, so `persistDomain` below is used PURELY as the
 * ownership-assertion seam (it writes no record, asserts only that the
 * opportunity belongs to this run's workspace), and there is no `projection`
 * (Founder-Inbox projection is P1.5).
 *
 * THREE hard properties (issue #82's 3-layer gate headline):
 *
 * 1. NO AUTONOMOUS SEND (spec §9 invariant: §9.1 step 10 "create external
 *    email draft only AFTER approval"; §9.3 "never contacts the person
 *    automatically"). This agent produces a DRAFT artifact ONLY, routed to
 *    founder approval (stage 10, review mode → `in_review`). There is NO code
 *    path here that sends/executes/publishes — no email/SMS/HTTP, no
 *    Gmail-draft creation (that is P1.8's controlled command). `permittedTools`
 *    is empty and there is no `projection` hook, so nothing external is ever
 *    invoked. VERIFIED BY ABSENCE + the NO-SEND test
 *    (`FOS1-FOLLOWUP-nosend`): the artifact stays `in_review`, no `approval`
 *    auto-decision row is written, and nothing external is called.
 *
 * 2. NO GUARANTEE IN THE APPLICANT-FACING DRAFT (AGENT_LESSONS P-004,
 *    MECHANICAL). The stage-7b `complianceReviewText` selector (issue #109,
 *    which replaced the keyword guarantee gate) is enumerated MECHANICALLY
 *    against EVERY field `buildBodyMarkdown` renders. See the exhaustive field
 *    classification immediately above the selector below; every rendered value
 *    is classified as exactly one of (i) input-derived, (ii) a closed Zod enum,
 *    (iii) gate-validated against a set, or (iv) scanned by the compliance
 *    review. A `guarantee-in-<field>` test exists per scanned field (body,
 *    subject, primaryCTA, a claim, a capability, a risk flag).
 *
 * 3. CONSENT (option B) + CLAIMS discipline. The draft's `channel` must be in
 *    the caller-supplied `consentedChannels` ALLOWLIST (reuse the allowlist
 *    `consentGate` — a non-consented channel BLOCKS, fail-closed). Every claim
 *    in `claimsManifest` must be in the caller-supplied `approvedClaims` set
 *    (`claimsInApprovedSetGate`). Every `personalizationSources[].sourceRef`
 *    must resolve to an `evidenceRecords` sourceRef (`factsResolveToSources`).
 *    FLAG (issue #82, #60/#68/#78 precedent): the FULL
 *    claims-approved-for-channel-and-offer + consent-cooldown + platform-draft
 *    gates are P1.8; this slice does the in-approved-SET + no-guarantee checks
 *    and treats `approvedClaims`/`consentedChannels` as least-privilege caller
 *    input, NOT live registry lookups.
 *
 * SECURITY-SENSITIVE (ADR-07 D7/D9, spec line 551): the model drafts; the
 * deterministic gates enforce. Untrusted personalization content (interaction
 * notes / transcript excerpts) reaches the model ONLY via `evidenceRecords`
 * (opaque, untrusted data) — the gates only ever see the Zod-validated
 * `input`/`output`, never raw text, so injected content can change what the
 * MODEL drafts but never what the GATES, MODE, or APPROVAL routing decide.
 *
 * FLAG (issue #82): no dedicated claims-approved gate, no consent registry, no
 * evidence table, and no CTA registry are seeded yet — `approvedClaims`,
 * `consentedChannels`, `availableCTAs`, `capabilities`, and `evidenceRecords`
 * are ALL least-privilege, caller-provided input sets (the same convention as
 * the prior agents), never live registry/service lookups inside a gate.
 */

// ---- Input (stage 1/3): least-privilege context the agent reasons over ---

/** The §7.1 follow-up artifact types this agent can draft — ALL already in the
 * canonical `artifact_type` enum (no migration). `followUpType` DRIVES the
 * artifact type 1:1 (see `artifact.artifactType` below). Declared as a
 * `satisfies ArtifactType[]` tuple so a typo can never diverge from the DB
 * enum. */
export const FOLLOW_UP_TYPES = [
  "offer_follow_up",
  "no_show_recovery",
  "unresponsive_recovery",
  "initial_response",
  "information_request",
  "objection_response",
] as const satisfies ArtifactType[];

export type FollowUpType = (typeof FOLLOW_UP_TYPES)[number];

export const personalizedFollowUpSourceRecordSchema = z.object({
  /** Stable identifier a personalizationSource can cite via its own sourceRef. */
  sourceRef: z.string().min(1),
  sourceType: z.enum([
    "application_field",
    "person_field",
    "opportunity_field",
    "interaction_note",
    "interaction_transcript",
    "prior_assessment",
  ]),
  /** The actual source content/excerpt the model may personalize from.
   * UNTRUSTED (spec line 551, same posture as `interaction.notes`/
   * `transcript_ref`) — passed as data, NEVER interpreted as instructions. */
  content: z.string().min(1),
});

export const personalizedFollowUpInputSchema = z.object({
  opportunity: z.object({
    id: z.string().uuid(),
    stage: z.string().min(1),
    primaryGoal: z.string().optional(),
    targetRole: z.string().optional(),
    targetTimeline: z.string().optional(),
  }),
  person: z.object({
    id: z.string().uuid(),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    currentRole: z.string().optional(),
    currentCompany: z.string().optional(),
    location: z.string().optional(),
  }),
  /** Which of the §7.1 follow-up types to draft — drives the artifact type. */
  followUpType: z.enum(FOLLOW_UP_TYPES),
  /** The channel this follow-up is drafted FOR (caller-supplied — the founder
   * chooses the channel; it is NOT a model output). Must be in
   * `consentedChannels` (consentGate, fail-closed). */
  channel: z.string().min(1),
  /** OPTION B allowlist (issue #82): channels for which consent has been
   * AFFIRMATIVELY recorded. FLAG: consent registry not seeded — least-
   * privilege caller-provided input (see file header). */
  consentedChannels: z.array(z.string().min(1)),
  /** The approved-claims allowlist — every `claimsManifest` entry must be in
   * this set. FLAG: claims registry not seeded — least-privilege caller input. */
  approvedClaims: z.array(z.string().min(1)),
  /** Capabilities the founder may reference (context for the model; the
   * `capabilitiesManifest` output is NOT subset-gated against this — see the
   * mechanical scan classification below, where it is a SCANNED field). */
  capabilities: z.array(z.string().min(1)),
  /** The available CTAs — the single `primaryCTA` output must be one of these
   * (`recommendedPathwayAvailableGate` reused with `subjectLabel: "CTA"`). */
  availableCTAs: z.array(z.string().min(1)),
  /** Evidence/source records — the ONLY sourceRefs a personalizationSource may
   * cite (factsResolveToSources). Untrusted content (spec line 551). FLAG: no
   * seeded Evidence table. */
  evidenceRecords: z.array(personalizedFollowUpSourceRecordSchema),
});

export type PersonalizedFollowUpInput = z.infer<typeof personalizedFollowUpInputSchema>;

// ---- Output (stage 6): the applicant-facing draft ------------------------

const personalizationSourceSchema = z.object({
  statement: z.string().min(1),
  /** MUST resolve to a `sourceRef` present in the input's `evidenceRecords`
   * (enforced by `factsResolveToSources`, not by this schema alone — the
   * schema only makes a personalizationSource STRUCTURALLY incapable of
   * omitting a source). */
  sourceRef: z.string().min(1),
});

export const personalizedFollowUpOutputSchema = z.object({
  /** Optional subject line (e.g. for an email channel). SCANNED by the
   * guarantee gate. */
  subject: z.string().min(1).optional(),
  /** The full applicant-facing message body. SCANNED. */
  body: z.string().min(1),
  /** EXACTLY ONE primary CTA (STRUCTURAL: a single required string, so the
   * output can never carry zero or multiple primary CTAs — see the FLAG in the
   * file/PR notes). Must be in `availableCTAs` (CTA-available gate). SCANNED. */
  primaryCTA: z.string().min(1),
  /** Every claim made in the draft — each MUST be in `approvedClaims`
   * (claimsInApprovedSetGate). Each entry is also SCANNED (a guarantee
   * smuggled into an "approved" claim must still be blocked). */
  claimsManifest: z.array(z.string().min(1)),
  /** Capabilities referenced in the draft. NOT subset-gated — each entry is
   * SCANNED by the guarantee gate. */
  capabilitiesManifest: z.array(z.string().min(1)),
  /** Personalization statements, each citing an evidence sourceRef. The
   * `statement` is SCANNED; the `sourceRef` is gate-validated by
   * factsResolveToSources (∈ evidenceRecords). */
  personalizationSources: z.array(personalizationSourceSchema),
  /** Risk flags the founder should review before approving. Each entry is
   * SCANNED by the guarantee gate. */
  riskFlags: z.array(z.string().min(1)),
});

export type PersonalizedFollowUpOutput = z.infer<typeof personalizedFollowUpOutputSchema>;

// ---- Definition ------------------------------------------------------------

/**
 * The ONLY sourceRefs `facts-resolve-to-sources` will accept for this run.
 * Defined ONCE and consumed by BOTH the gate and `promptVocabularies` below, so
 * "what the model is told" and "what the gate enforces" are the same
 * expression and cannot drift (#127, P-004).
 *
 * The failure this prevents has now happened twice on live runs (enrollment
 * brief run 1, call preparation run 10): the model cited REAL input fields —
 * `person.currentRole`, `opportunity.stage` — while the gate accepts only
 * `evidenceRecords[].sourceRef` spellings, and the majority of runs blocked. It
 * was grounding honestly against a vocabulary nobody had shown it.
 */
function selectCitableSourceRefs(input: PersonalizedFollowUpInput): string[] {
  return input.evidenceRecords.map((r) => r.sourceRef);
}

/** The ONLY CTAs `cta-available` will accept. Shared with the gate below. */
function selectAvailableCTAs(input: PersonalizedFollowUpInput): string[] {
  return input.availableCTAs;
}

/** The ONLY claims `claims-in-approved-set` will accept. Shared with the gate. */
function selectApprovedClaims(input: PersonalizedFollowUpInput): string[] {
  return input.approvedClaims;
}

/**
 * Capabilities the founder may reference. NOT gate-enforced (there is no
 * capabilities gate — see the mechanical classification below, where
 * `capabilitiesManifest` is a SCANNED field), so this is the one vocabulary
 * with no gate to drift from. Surfaced anyway, for the same reason
 * `call-preparation.ts` surfaces `permittedClaims`: a closed set stops the
 * model inventing a capability the founder does not have — and here that
 * invention would land in APPLICANT-FACING copy, not an internal brief.
 */
function selectReferenceableCapabilities(input: PersonalizedFollowUpInput): string[] {
  return input.capabilities;
}

export const FOS_PERSONALIZED_FOLLOW_UP_AGENT_KEY = "fos.personalized_follow_up";
export const FOS_PERSONALIZED_FOLLOW_UP_FEATURE_FLAG_KEY = "fos.personalized_follow_up";

export const fosPersonalizedFollowUpAgentDefinition: AgentDefinition<
  PersonalizedFollowUpInput,
  PersonalizedFollowUpOutput
> = {
  key: FOS_PERSONALIZED_FOLLOW_UP_AGENT_KEY,
  version: "1.0.0",
  objective:
    "Draft a concise, channel-specific follow-up message for this enrollment opportunity with " +
    "exactly one primary call-to-action, a claims manifest, a capabilities manifest, " +
    "personalization sources, and risk flags. Only draft on a channel with affirmatively " +
    "recorded consent, only make claims that are in the approved-claims set, cite a source for " +
    "every personalization, and NEVER guarantee an employment, recruiter, salary, or interview " +
    "outcome. This produces a DRAFT for founder approval — it NEVER sends.",
  inputSchema: personalizedFollowUpInputSchema,
  outputSchema: personalizedFollowUpOutputSchema,
  // NO tools: this agent has no send/command/HTTP capability by construction
  // (issue #82 hard property #1 — no autonomous send).
  permittedTools: [],
  permittedMemoryScopes: [
    "enrollment_opportunity",
    "person",
    "evidence_records",
    "approved_claims",
  ],
  autonomyCeiling: "review",
  featureFlagKey: FOS_PERSONALIZED_FOLLOW_UP_FEATURE_FLAG_KEY,
  /**
   * #127, propagated here by P1.10d-6. Surfaced to the model verbatim in the
   * user turn (see PromptVocabulary); the RULE about copying verbatim is static
   * system-prompt policy, so no input-derived string reaches the policy channel
   * (D9).
   *
   * Every entry reuses the SAME selector its gate enforces with, so the pair
   * cannot drift. This agent has THREE gate-enforced closed sets — more than
   * any agent wired so far — and all three block the run when missed, which
   * makes the omission strictly more expensive here than on the two agents it
   * has already cost a full live run.
   */
  promptVocabularies: (input) => [
    { field: "personalizationSources[].sourceRef", allowed: selectCitableSourceRefs(input) },
    { field: "primaryCTA", allowed: selectAvailableCTAs(input) },
    // The highest-value entry. A model that PARAPHRASES an approved claim
    // ("weekly coaching sessions are included") makes a claim the founder
    // approved, in words the gate has never seen — a block that reads like the
    // gate catching an unapproved claim.
    { field: "claimsManifest", allowed: selectApprovedClaims(input) },
    // Not gate-enforced; the stage-7b review is the only backstop (same
    // situation and same rationale as call_preparation's `permittedClaims`).
    { field: "capabilitiesManifest", allowed: selectReferenceableCapabilities(input) },
  ],
  deterministicGates: [
    featureModeAllowedGate({
      key: "fos.personalized_follow_up.mode-allowed",
      allowedModes: ["shadow", "review"],
    }),
    // Consent, option B allowlist (issue #82). NOTE: unlike
    // `next-best-action.ts`, `channel` here is a caller-supplied INPUT (the
    // founder drafts a follow-up FOR a channel), so the selector reads
    // `input.channel`, not the model output — the generalized second selector
    // parameter makes this possible without a second gate.
    consentGate<PersonalizedFollowUpInput, PersonalizedFollowUpOutput>({
      key: "fos.personalized_follow_up.consent",
      selectProposedActionChannel: (_output, input) => input.channel,
      selectConsentedChannels: (input) => input.consentedChannels,
    }),
    // CTA-available: the single primaryCTA must be in `availableCTAs`. Same
    // shape as offer/pathway availability — REUSE `recommendedPathwayAvailableGate`
    // (issue #60 precedent) with the "CTA" subject label rather than a new
    // gate. A CTA is REQUIRED — there is no legitimate "undetermined" CTA — so
    // the sentinel is DISABLED (`undeterminedValue: null`): every value must be
    // in the set, and the model cannot bypass the check by emitting the
    // "undetermined" string (issue #82 3-layer gate, silent-failure finding).
    recommendedPathwayAvailableGate<PersonalizedFollowUpInput, PersonalizedFollowUpOutput>({
      key: "fos.personalized_follow_up.cta-available",
      selectRecommendedPathway: (output) => output.primaryCTA,
      selectAvailablePathways: selectAvailableCTAs,
      subjectLabel: "CTA",
      undeterminedValue: null,
    }),
    // Claims discipline: every claim in the manifest must be in the approved
    // set. FLAG: full claims-approved-for-channel-and-offer gate is P1.8.
    claimsInApprovedSetGate<PersonalizedFollowUpInput, PersonalizedFollowUpOutput>({
      key: "fos.personalized_follow_up.claims-in-approved-set",
      selectClaims: (output) => output.claimsManifest,
      selectApprovedClaims,
    }),
    // Personalization grounding: every personalization statement's sourceRef
    // must resolve to an evidence record the model was actually given.
    factsResolveToSourcesGate<PersonalizedFollowUpInput, PersonalizedFollowUpOutput>({
      key: "fos.personalized_follow_up.facts-resolve-to-sources",
      selectObservedFacts: (output) => output.personalizationSources,
      selectValidSourceRefs: selectCitableSourceRefs,
    }),
    // ============================================================
    // MECHANICAL guarantee-scan classification (AGENT_LESSONS P-004).
    // EVERY value `buildBodyMarkdown` renders, classified as exactly one of:
    //   (i)   input-derived (not model output)
    //   (ii)  a closed Zod enum
    //   (iii) gate-validated against a set (an earlier-ordered gate above)
    //   (iv)  SCANNED by complianceReviewText below
    // Re-run this enumeration on ANY change to `buildBodyMarkdown`, the output
    // schema, OR a gate's coverage (a fix counts). A model-authored rendered
    // value that is none of (i)-(iv) is a guarantee leak.
    //
    //   input.followUpType              → (ii) closed enum (FOLLOW_UP_TYPES)
    //   input.person.firstName/lastName → (i)  input-derived
    //   input.channel                   → (i)  input-derived + (iii) consent gate
    //   output.subject (optional)       → (iv) SCANNED
    //   output.body                     → (iv) SCANNED
    //   output.primaryCTA               → (iii) cta-available gate + (iv) SCANNED
    //   output.claimsManifest[each]     → (iii) claims-in-approved-set + (iv) SCANNED
    //   output.capabilitiesManifest[each] → (iv) SCANNED (NOT subset-gated)
    //   output.personalizationSources[].statement → (iv) SCANNED
    //   output.personalizationSources[].sourceRef → (iii) facts-resolve-to-sources
    //                                     (∈ evidenceRecords, a caller-input set;
    //                                     the earlier-ordered gate blocks any ref
    //                                     not in that set, so a passing sourceRef
    //                                     equals a caller-input value, never a
    //                                     model-authored guarantee — mirrors
    //                                     call-preparation's observedFacts.sourceRef)
    //   output.riskFlags[each]          → (iv) SCANNED
    // ============================================================
  ],
  // Stage-7b semantic compliance review (Option C slice 2, issue #109) — the
  // eval-validated guarantee classifier replaces the removed keyword gate. Same
  // fields the old gate's `selectText` scanned (see the mechanical enumeration
  // above) — keep in sync with `buildBodyMarkdown`.
  //
  // Voice tagging (#140 / F-K), propagated here by P1.10d-6. Coverage is
  // UNCHANGED — every text is still classified; only the appeal path differs.
  //
  //   own_voice     — the agent asserting something. Full floor, unappealable.
  //   reports_input — a field whose PURPOSE is to describe untrusted input, so a
  //                   `guarantee` near an employment noun means the agent is
  //                   REPORTING a guarantee, not making one. The floor escalates
  //                   to tier 2 (which reads meaning) instead of blocking.
  //
  // Per-field reasoning, made FRESH — this is the first agent whose output is
  // OUTBOUND COPY, so the split is not the one the internal-brief agents use.
  // The dividing question here is not "does this recount the call?" but "does
  // this text get DELIVERED TO A PERSON?". `buildBodyMarkdown` answers it: the
  // "## Message" section is what the applicant receives; the manifest and
  // audit sections below it exist for the founder reviewing the draft.
  //
  //   subject — own_voice. It is sent. A guarantee in a subject line is a
  //     guarantee MADE to the applicant, whatever prompted it.
  //   body — own_voice, and the single most load-bearing tag in this file. It
  //     IS the message. Note the counter-read that moved call_preparation's
  //     `summary` to reports_input after live run 11: a follow-up body does in
  //     practice recount what the applicant said. That analogy does NOT carry
  //     here, because call_preparation's summary is an internal brief the
  //     founder reads and this text is copy the APPLICANT reads. Recounting an
  //     applicant's own words back to them in a sent message is still the
  //     founder speaking. This field keeps the unappealable floor.
  //   primaryCTA — own_voice. Also sent. Gate-restricted to `availableCTAs`,
  //     but a founder-supplied CTA is not thereby licensed to promise an
  //     outcome, and FOS1-FOLLOWUP-guarantee-cta exists for exactly that case.
  //   claimsManifest — own_voice. Direct precedent: call_preparation's
  //     `permittedClaims` stays own_voice because "a prohibited guarantee
  //     smuggled into an APPROVED claim must still be blocked"
  //     (FOS1-FOLLOWUP-guarantee-claim asserts it here too). Note this field is
  //     NOT the mirror of `claimsToAvoid`: naming a forbidden claim is that
  //     field's purpose, and MAKING a claim is this one's.
  //   capabilitiesManifest — own_voice. It is the only scanned field with no
  //     subset gate at all, and it asserts what the programme does.
  //   personalizationSources[].statement — reports_input. Each entry MUST cite
  //     an evidenceRecord (facts-resolve-to-sources), so it is by construction
  //     a restatement of untrusted source content — the same class as every
  //     other agent's `observedFacts`. It is rendered in the founder-facing
  //     "## Personalization sources" audit section, NOT in the sent message.
  //     FLAG, a live run could overturn this: if the model writes these as
  //     ready-to-send sentences that a founder would paste into the body, the
  //     "not delivered" premise weakens and the tag should move to own_voice.
  //   riskFlags — reports_input. Its purpose is to warn the FOUNDER about the
  //     draft and its evidence, which on this agent routinely means naming
  //     guarantee language found in untrusted personalization content ("the
  //     transcript asks for a guaranteed job offer"). Flooring that is F-K
  //     verbatim — the failure that hard-blocked objection_intelligence's own
  //     correct report of an injection. Not sent to anyone. FLAG: if a live run
  //     shows riskFlags used to ASSERT rather than to warn, this moves.
  complianceReviewText: (output) => [
    ...(output.subject
      ? [{ text: output.subject, field: "subject", voice: "own_voice" as const }]
      : []),
    { text: output.body, field: "body", voice: "own_voice" as const },
    { text: output.primaryCTA, field: "primaryCTA", voice: "own_voice" as const },
    ...output.claimsManifest.map((text) => ({
      text,
      field: "claimsManifest",
      voice: "own_voice" as const,
    })),
    ...output.capabilitiesManifest.map((text) => ({
      text,
      field: "capabilitiesManifest",
      voice: "own_voice" as const,
    })),
    // --- reports_input: the two founder-facing audit sections ---------------
    ...output.personalizationSources.map((p) => ({
      text: p.statement,
      field: "personalizationSources[].statement",
      voice: "reports_input" as const,
    })),
    ...output.riskFlags.map((text) => ({
      text,
      field: "riskFlags",
      voice: "reports_input" as const,
    })),
  ],
  artifact: {
    // `followUpType` DRIVES the artifact type 1:1 (all six values are already
    // in the canonical `artifact_type` enum — NO migration). Expressed via the
    // function form of `ArtifactSpec.artifactType` (generalized in this slice,
    // issue #82) so the type varies per run; `FOLLOW_UP_TYPES satisfies
    // ArtifactType[]` guarantees the return value is always a canonical enum
    // member. `domain: "enrollment"`.
    artifactType: (input) => input.followUpType,
    domain: "enrollment",
    buildTitle: (input) =>
      `Follow-Up (${input.followUpType}): ${input.person.firstName} ${input.person.lastName}`,
    buildBodyMarkdown: (input, output) =>
      [
        `# Follow-Up (${input.followUpType}): ${input.person.firstName} ${input.person.lastName}`,
        "",
        `**Channel:** ${input.channel}`,
        ...(output.subject ? [`**Subject:** ${output.subject}`] : []),
        "",
        "## Message",
        output.body,
        "",
        `**Primary CTA:** ${output.primaryCTA}`,
        "",
        "## Claims referenced",
        ...(output.claimsManifest.length ? output.claimsManifest.map((c) => `- ${c}`) : ["- none"]),
        "",
        "## Capabilities referenced",
        ...(output.capabilitiesManifest.length
          ? output.capabilitiesManifest.map((c) => `- ${c}`)
          : ["- none"]),
        "",
        "## Personalization sources",
        ...(output.personalizationSources.length
          ? output.personalizationSources.map((p) => `- ${p.statement} _(source: ${p.sourceRef})_`)
          : ["- none"]),
        "",
        "## Risk flags",
        ...(output.riskFlags.length ? output.riskFlags.map((r) => `- ${r}`) : ["- none noted"]),
      ].join("\n"),
    buildClaimsManifest: (input, output) => ({
      // Internal audit aid: the channel this draft targets, and the exact
      // approved claims / evidence sourceRefs it actually used, so a reviewer
      // can spot-check consent + grounding without re-deriving them.
      channel: input.channel,
      claims: output.claimsManifest,
      personalizationSourceRefs: output.personalizationSources.map((p) => p.sourceRef),
    }),
  },
  // Stage 9b: NO domain record is written (spec §7.1 gives the Follow-Up agent
  // no domain entity, exactly like call-preparation.ts) — this hook exists
  // SOLELY as the ownership-assertion seam (issue #82): it re-reads the
  // opportunity and asserts it belongs to this run's workspace. A throw here
  // rolls back the artifact/version/event `createArtifact` wrote just before it
  // (issue #63) — never an orphaned artifact.
  persistDomain: async ({ deps, runContext }, input) => {
    await loadOwnedOpportunity(deps.db, input.opportunity.id, runContext.workspaceId);
  },
  // No `projection` hook (spec boundary, issue #82): NO send/command/Gmail-draft
  // (P1.8), NO Founder-Inbox projection (P1.5). Hard property #1: there is no
  // external-effect code path in this definition at all.
};
