import { z } from "zod";

/**
 * The run transcript — the ONLY interface between the TypeScript executor and
 * the quarantined Python grader (design §2 D2, §4). One JSON object per
 * `runAgent` invocation, serialised one-per-line into a JSONL file.
 *
 * Every field here is either returned by `runAgent` or read from the eval
 * database by the runner. Nothing is inferred, summarised, or judged: the
 * grader must be able to reach its verdict from this record alone, without an
 * LLM and without importing any TypeScript (design §2 D3).
 */

/** Terminal statuses of `runAgent` (mirrors `AgentRunStatus` in @fos/agents). */
export const evalRunStatusValues = [
  "succeeded",
  "evaluation_failed",
  "policy_blocked",
  "error",
] as const;

/**
 * Artifact approval statuses an eval run may legitimately produce. `approved`
 * is DELIBERATELY ABSENT: no agent run may approve its own artifact, so an
 * `approved` value is a critical-failure condition (design §2 D6.2) and the
 * schema refuses to represent it. A transcript that cannot be written is a
 * louder signal than one that is written and later graded.
 */
export const evalArtifactVersionStatusValues = ["draft", "in_review", "rejected"] as const;

export const gateEvaluationRecordSchema = z.object({
  key: z.string().min(1),
  allowed: z.boolean(),
  /** Present only on a block. Excluded from paired-control comparison, since a
   * reason may embed input-derived text that differs between fixture and
   * control by construction (design §6). */
  reason: z.string().optional(),
});

export type GateEvaluationRecord = z.infer<typeof gateEvaluationRecordSchema>;

export const runTranscriptSchema = z
  .object({
    fixture_id: z.string().min(1),
    agent_key: z.string().min(1),
    agent_version: z.string().min(1),
    /** 0-indexed repetition. Live runs are non-deterministic, so each fixture
     * is executed N times and every run gets its own transcript line. */
    repetition: z.number().int().nonnegative(),
    /** When set, this run is the benign CONTROL for the named fixture. */
    control_for: z.string().min(1).nullable(),
    run_id: z.string().uuid(),
    status: z.enum(evalRunStatusValues),
    mode: z.enum(["shadow", "review", "live"]),
    retry_count: z.number().int().nonnegative(),
    /** The definition's FULL `deterministicGates[]` order. The grader needs
     * this to distinguish "gate did not run because an earlier one blocked"
     * (legal) from "gate is missing from the definition" (a defect) — design
     * §5. Emitting it here is what keeps the Python side from having to know
     * anything about TypeScript. */
    declared_gate_keys: z.array(z.string().min(1)),
    /** An ORDERED PREFIX of `declared_gate_keys`: `evaluateGates` stops at the
     * first block, so a run blocked by gate 2 of 3 emits two entries. */
    gate_evaluations: z.array(gateEvaluationRecordSchema),
    /** Stage-7b semantic compliance review. `null` when the stage did not run. */
    compliance_review: z.object({ blocked: z.boolean(), reason: z.string().optional() }).nullable(),
    artifact: z
      .object({
        artifact_id: z.string().uuid(),
        version_id: z.string().uuid(),
        version_status: z.enum(evalArtifactVersionStatusValues),
      })
      .nullable(),
    projection_deferred: z.boolean(),
    model: z.string().min(1),
    usage: z.object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    }),
    latency_ms: z.number().nonnegative(),
    /** Populated only when `status === "error"`. */
    error: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    // The prefix invariant (design §5), enforced at write time so a malformed
    // transcript can never reach the grader.
    if (value.gate_evaluations.length > value.declared_gate_keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gate_evaluations"],
        message: `gate_evaluations (${value.gate_evaluations.length}) is longer than declared_gate_keys (${value.declared_gate_keys.length}); it must be an ordered prefix`,
      });
      return;
    }
    value.gate_evaluations.forEach((evaluation, index) => {
      if (evaluation.key !== value.declared_gate_keys[index]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["gate_evaluations", index, "key"],
          message: `gate_evaluations[${index}].key is "${evaluation.key}" but declared_gate_keys[${index}] is "${value.declared_gate_keys[index]}"; evaluations must follow declared order`,
        });
      }
    });
  });

export type RunTranscript = z.infer<typeof runTranscriptSchema>;
