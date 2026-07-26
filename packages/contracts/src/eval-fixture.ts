import { z } from "zod";
import { evalArtifactVersionStatusValues, evalRunStatusValues } from "./eval-transcript.js";

/**
 * Fixture schema v2 (design §6). v1 encoded its most important assertions as
 * English prose in `output_schema_constraints` — e.g. "gate evaluations ... are
 * IDENTICAL to a benign control" — which nothing can mechanically check and
 * which ADR-07 forbids resolving with an LLM judge. v2 re-encodes exactly the
 * same intent as typed assertions.
 *
 * `schema_version` is REQUIRED and must be 2. A v1 fixture is rejected rather
 * than heuristically upgraded: guessing at an assertion is how a gate silently
 * stops being checked.
 */

export const EVAL_FIXTURE_SCHEMA_VERSION = 2 as const;

/** Per-gate expectation, graded by the prefix rule in design §5. */
export const gateOutcomeValues = ["pass", "fail"] as const;

/**
 * Transcript field paths a paired benign control must match. `gate_evaluations`
 * compares the ordered list of (key, allowed) pairs only — `reason` strings are
 * excluded because a reason may embed input-derived text that differs between
 * fixture and control by construction.
 */
export const controlMatchFieldValues = [
  "status",
  "gate_evaluations",
  "artifact.version_status",
  "compliance_review",
] as const;

/** Assertion names that escalate an ordinary failure to CRITICAL (design §2 D6). */
export const criticalAssertionValues = [
  "paired_control",
  "artifact_version_status",
  "status",
] as const;

export const evalFixtureV2Schema = z
  .object({
    fixture_id: z.string().min(1),
    agent_key: z.string().min(1),
    schema_version: z.literal(EVAL_FIXTURE_SCHEMA_VERSION),
    description: z.string().min(1),
    /** The `runAgent` input. Entity ID fields are PLACEHOLDERS — the runner
     * rebinds them to freshly-seeded canonical rows before the run (plan §A1). */
    input: z.record(z.unknown()),
    expected: z
      .object({
        /** Any-of. A live model may legitimately land on more than one terminal
         * status for the same input (e.g. an injection fixture either succeeds
         * cleanly or is blocked — both are correct, silently complying is not). */
        status: z.array(z.enum(evalRunStatusValues)).min(1),
        gate_outcomes: z
          .record(z.enum(gateOutcomeValues))
          .refine((v) => Object.keys(v).length > 0, {
            message: "gate_outcomes must assert at least one gate",
          }),
        /** `approved` is not a member of `evalArtifactVersionStatusValues`, so a
         * fixture permitting it fails to parse — the spec bug is caught at load
         * time rather than becoming a green grade. */
        artifact_version_status: z.array(z.enum(evalArtifactVersionStatusValues)).min(1),
        max_retry_count: z.number().int().nonnegative(),
        /** Expected stage-7b outcome; `null` means "not asserted". */
        compliance_review_blocked: z.boolean().nullable(),
        paired_control: z.string().min(1).nullable(),
        control_must_match: z.array(z.enum(controlMatchFieldValues)),
      })
      .strict(),
    critical_if_failed: z.array(z.enum(criticalAssertionValues)),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { paired_control: pairedControl, control_must_match: mustMatch } = value.expected;
    if (pairedControl === null && mustMatch.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected", "control_must_match"],
        message: "control_must_match must be empty when paired_control is null",
      });
    }
    if (pairedControl !== null && mustMatch.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected", "control_must_match"],
        message: "paired_control is set but control_must_match is empty; nothing would be compared",
      });
    }
  });

export type EvalFixtureV2 = z.infer<typeof evalFixtureV2Schema>;
