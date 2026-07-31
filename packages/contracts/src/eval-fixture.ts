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

/**
 * Structural operators an `output_assertion` may use (design §6.1). Six, all
 * comparing shapes or exact values.
 *
 * There is deliberately NO keyword or substring operator. A `contains_any`
 * would let a fixture express "objections[] includes a price objection" — and
 * that is precisely the brittleness that already failed here: the
 * prohibited-guarantee gate was keyword-based, leaked four times (lesson
 * P-004), and was replaced by a semantic classifier in #110. Re-introducing
 * keyword matching one layer up would repeat a mistake this project has
 * already paid for. Constraints that genuinely need judgment stay as prose in
 * `description`, asserted by nothing — which is honest, where a brittle
 * assertion is not.
 */
export const outputAssertionOps = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "min_length",
  "max_length",
] as const;

/** One mechanically-checkable claim about a field of the agent's output. */
export const outputAssertionSchema = z
  .object({
    /** Dot path into the run's `output`, e.g. `"readiness"` or `"unknowns"`. */
    path: z.string().min(1),
    op: z.enum(outputAssertionOps),
    /** `in`/`not_in` take an array; `min_length`/`max_length` a number;
     * `equals`/`not_equals` a scalar. */
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  })
  .strict()
  .superRefine((a, ctx) => {
    const isArrayOp = a.op === "in" || a.op === "not_in";
    const isLengthOp = a.op === "min_length" || a.op === "max_length";
    if (isArrayOp && !Array.isArray(a.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `${a.op} requires an array value`,
      });
    }
    if (isLengthOp && typeof a.value !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `${a.op} requires a numeric value`,
      });
    }
    if (!isArrayOp && !isLengthOp && Array.isArray(a.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: `${a.op} requires a scalar value`,
      });
    }
  });

export type OutputAssertion = z.infer<typeof outputAssertionSchema>;

export const evalFixtureV2Schema = z
  .object({
    fixture_id: z.string().min(1),
    agent_key: z.string().min(1),
    schema_version: z.literal(EVAL_FIXTURE_SCHEMA_VERSION),
    description: z.string().min(1),
    /** The `runAgent` input. Entity ID fields are PLACEHOLDERS — the runner
     * rebinds them to freshly-seeded canonical rows before the run (plan §A1). */
    input: z.record(z.unknown()),
    /**
     * Runner-level setup, distinct from the agent's `input`.
     *
     * Exists for F-D. D6.3 makes "a `succeeded` status where `policy_blocked`
     * was expected" a CRITICAL failure — a gate that should have blocked and
     * did not. Nothing could exercise it, because every reachable block
     * depended on the live model misbehaving, and a fixture cannot REQUIRE the
     * model to misbehave.
     *
     * `feature_flag_enabled: false` gives a deterministic block instead: the
     * pipeline refuses at stage 2 with `policy_blocked` and
     * `reason: "feature_flag_disabled"`, before any gate and before any model
     * call. The fixture costs nothing to run and cannot flake.
     *
     * Optional and defaulting to enabled, so every existing fixture is
     * unaffected and `schema_version` does not move.
     */
    runner: z.object({ feature_flag_enabled: z.boolean() }).strict().optional(),
    expected: z
      .object({
        /** Any-of. A live model may legitimately land on more than one terminal
         * status for the same input (e.g. an injection fixture either succeeds
         * cleanly or is blocked — both are correct, silently complying is not). */
        status: z.array(z.enum(evalRunStatusValues)).min(1),
        /**
         * Gate assertions. When PRESENT it must assert at least one gate — an
         * empty map is a fixture that forgot, not a fixture that means "none".
         *
         * OPTIONAL, because a run blocked at stage 2 (a disabled feature flag)
         * never reaches the gates, so there is no gate outcome to assert. The
         * superRefine below makes this exact: it may be omitted if and ONLY if
         * the fixture disables the flag, and it MUST be omitted when it does.
         * Asserting a gate that cannot run is a defect either way.
         *
         * GRADER SEMANTICS: an absent `gate_outcomes` means "gates did not run
         * and none are asserted" — never "any gate outcome is acceptable".
         */
        gate_outcomes: z
          .record(z.enum(gateOutcomeValues))
          .refine((v) => Object.keys(v).length > 0, {
            message: "gate_outcomes must assert at least one gate when present",
          })
          .optional(),
        /** `approved` is not a member of `evalArtifactVersionStatusValues`, so a
         * fixture permitting it fails to parse — the spec bug is caught at load
         * time rather than becoming a green grade. */
        artifact_version_status: z.array(z.enum(evalArtifactVersionStatusValues)).min(1),
        max_retry_count: z.number().int().nonnegative(),
        /** Expected stage-7b outcome; `null` means "not asserted". */
        compliance_review_blocked: z.boolean().nullable(),
        paired_control: z.string().min(1).nullable(),
        control_must_match: z.array(z.enum(controlMatchFieldValues)),
        /**
         * Mechanically-checkable claims about the agent's OUTPUT (design §6.1).
         * Optional and defaulting to `[]`, so fixtures written before the
         * amendment stay valid. Failing one is an ORDINARY failure, never
         * critical — `criticalAssertionValues` is unchanged and D6 stands.
         */
        output_assertions: z.array(outputAssertionSchema).default([]),
      })
      .strict(),
    critical_if_failed: z.array(z.enum(criticalAssertionValues)),
  })
  .strict()
  .superRefine((value, ctx) => {
    // gate_outcomes <-> pre-gate block, both directions. Keeping this exact is
    // what stops "optional" degrading into "sometimes forgotten": a fixture
    // that runs gates MUST assert them, and one that cannot reach them MUST
    // NOT pretend to.
    const blocksBeforeGates = value.runner?.feature_flag_enabled === false;
    if (!blocksBeforeGates && value.expected.gate_outcomes === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected", "gate_outcomes"],
        message:
          "gate_outcomes is required unless the fixture sets runner.feature_flag_enabled=false, " +
          "which blocks at stage 2 before any gate runs",
      });
    }
    if (blocksBeforeGates && value.expected.gate_outcomes !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expected", "gate_outcomes"],
        message:
          "a fixture with runner.feature_flag_enabled=false blocks before any gate runs, " +
          "so it must not assert gate outcomes",
      });
    }
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
