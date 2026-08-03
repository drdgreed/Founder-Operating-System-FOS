import { describe, expect, it } from "vitest";
import {
  ZodArray,
  ZodBoolean,
  ZodDefault,
  ZodEnum,
  ZodNullable,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodString,
  ZodType,
} from "zod";
import { EVAL_AGENTS } from "../eval-run.js";
import type { ComplianceReviewText } from "../../packages/agents/src/types.js";

/**
 * P-004 (docs/AGENT_LESSONS.md), in its intended form.
 *
 * Five separate fixes were made for `fos.enrollment_brief` and never
 * propagated as other agents were wired — each omission cost a live
 * production failure and a full debugging cycle:
 *
 *   1. `promptVocabularies` missing            -> fos.call_preparation blocked 7/7 live runs.
 *   2. `complianceReviewText` bare strings      -> fos.objection_intelligence hard-blocked its
 *                                                  OWN correct report of a prompt injection.
 *   3. no per-agent `stubOutput` in EVAL_AGENTS -> a dry-run that tests nothing (wrong shape).
 *   4. no EVAL_AGENTS entry at all              -> the agent's fixtures silently never ran.
 *   5. fixtures stuck on schema_version 1       -> (fixture-side; enforced by
 *                                                  packages/contracts/src/__tests__/enrollment-brief-fixtures.test.ts).
 *
 * A judgment-maintained checklist drifts silently — the fix is a mechanical
 * enumeration a test enforces, not a list a human is trusted to remember.
 * This suite derives its agent list FROM `EVAL_AGENTS` itself (never a
 * hardcoded name), so a NEW agent that is registered but skips one of these
 * steps fails here immediately, and an agent that is never registered at all
 * is simply never covered by ANY of these checks — which is finding #4 above,
 * made visible by construction rather than asserted directly.
 *
 * Modeled directly on `FOS1-EB-VOICE-*` in
 * packages/agents/src/__tests__/enrollment-brief.test.ts, generalized across
 * every registered agent instead of asserting one definition by name.
 */

/** Unwraps optional/nullable/default wrapping to the underlying Zod node. */
function unwrap(schema: ZodType): ZodType {
  if (schema instanceof ZodOptional || schema instanceof ZodNullable)
    return unwrap(schema.unwrap());
  if (schema instanceof ZodDefault) return unwrap(schema.removeDefault());
  return schema;
}

/**
 * A schema-driven, non-empty sample value for any Zod node this repo's agent
 * OUTPUT schemas use. Mirrors the same-purpose walker in
 * packages/agents/src/schema-to-json.ts: unsupported nodes throw rather than
 * silently emitting an empty/wrong value, so an output schema that later
 * grows a shape this walker doesn't understand fails loudly here instead of
 * quietly dropping a field from coverage.
 *
 * Optional/nullable/default fields are POPULATED, not skipped — a skipped
 * optional field would under-exercise `complianceReviewText`'s conditional
 * branches (e.g. `fos.objection_intelligence`'s `o.sourceRef ? [...] : []`),
 * which is exactly the kind of gap this suite exists to close.
 */
function sampleFor(schema: ZodType): unknown {
  const node = unwrap(schema);
  if (node instanceof ZodString) return "sample text";
  if (node instanceof ZodNumber) return 1;
  if (node instanceof ZodBoolean) return true;
  if (node instanceof ZodEnum) return node.options[0];
  if (node instanceof ZodArray) return [sampleFor(node.element)];
  if (node instanceof ZodObject) {
    const shape = node.shape as Record<string, ZodType>;
    return Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, sampleFor(value)]));
  }
  throw new Error(
    `sampleFor: unsupported Zod type "${node.constructor.name}" — extend this walker, ` +
      "the same way schema-to-json.ts's zodToJsonSchema would need extending.",
  );
}

/**
 * Resolves a `complianceReviewText` field path against the definition's real
 * output schema. Path-aware rather than a flat `Object.keys` membership
 * check, because BOTH notations are legitimate and already in live use side
 * by side in this codebase: enrollment-brief/call-preparation tag array
 * fields with the bare array name ("observedFacts"), while
 * objection-intelligence tags array-element sub-fields with the SAME
 * bracket notation `promptVocabularies` already uses everywhere for this
 * exact purpose (e.g. "observedFacts[].sourceRef") — "objections[].category".
 * Treating the bracket form as invalid would be a false positive against a
 * real, load-bearing convention, not a caught bug. A genuinely WRONG path (a
 * typo, a field renamed in the schema but not here) still fails to resolve
 * and is still caught — that's the anti-drift property this exists for.
 */
function isRealOutputField(schema: ZodType, field: string): boolean {
  const segments = field.split("[].").flatMap((segment) => segment.split("."));
  let current = unwrap(schema);
  for (const segment of segments) {
    if (current instanceof ZodArray) current = unwrap(current.element);
    if (!(current instanceof ZodObject)) return false;
    const shape = current.shape as Record<string, ZodType>;
    const next = shape[segment];
    if (next === undefined) return false;
    current = unwrap(next);
  }
  return true;
}

describe("P-004 guard: the enrollment_brief propagation checklist, enforced for every EVAL_AGENTS entry", () => {
  const entries = Object.entries(EVAL_AGENTS);

  it("FOS1-PROP-00: the registry is non-empty — an empty registry would make every check below vacuously pass", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)(
    "FOS1-PROP-01: %s's definition declares promptVocabularies",
    (agentKey, setup) => {
      expect(
        typeof setup.definition.promptVocabularies,
        `${agentKey}: missing promptVocabularies. This is the exact omission that blocked ` +
          "fos.call_preparation 7/7 on its first live run — the model was never shown the " +
          "vocabulary its own gate enforces, so it grounded honestly against a vocabulary " +
          "nobody disclosed.",
      ).toBe("function");
    },
  );

  it.each(entries)(
    "FOS1-PROP-02: %s tags every complianceReviewText entry, and every tagged field name is real",
    (agentKey, setup) => {
      const { definition } = setup;
      if (!definition.complianceReviewText) {
        // No currently-registered agent omits this, but a future agent with no
        // founder-facing free text legitimately could — nothing to check then.
        return;
      }
      const outputSchema = definition.outputSchema as ZodType;
      const sampleOutput = sampleFor(outputSchema);
      const reviewEntries = definition.complianceReviewText(sampleOutput as never);

      const bareStrings = reviewEntries.filter((entry) => typeof entry === "string");
      expect(
        bareStrings,
        `${agentKey}: bare (untagged) complianceReviewText entries default to own_voice, ` +
          "unappealably. This is exactly how fos.objection_intelligence hard-blocked its own " +
          `correct report of a prompt injection before voice tagging: ${JSON.stringify(bareStrings)}`,
      ).toEqual([]);

      const tagged = reviewEntries.filter(
        (entry): entry is ComplianceReviewText => typeof entry !== "string",
      );
      const unknownFields = [...new Set(tagged.map((entry) => entry.field))].filter(
        (field) => !isRealOutputField(outputSchema, field),
      );
      expect(
        unknownFields,
        `${agentKey}: complianceReviewText field name(s) do not resolve against its own output ` +
          `schema: ${unknownFields.join(", ")}. A field name that drifted from the schema is ` +
          "undetectable by inspection and defeats the anti-drift purpose voice tagging exists for.",
      ).toEqual([]);
    },
  );

  it.each(entries)(
    "FOS1-PROP-03: %s namespaces every declared gate key with its own agent key",
    (agentKey, setup) => {
      const badKeys = setup.definition.deterministicGates
        .map((gate) => gate.key)
        .filter((key) => !key.startsWith(`${agentKey}.`));
      expect(
        badKeys,
        `${agentKey}: gate key(s) not namespaced "${agentKey}.<name>": ${badKeys.join(", ")}. ` +
          "An un-namespaced gate key can collide with another agent's gate of the same short " +
          "name in any shared evaluation/audit trail.",
      ).toEqual([]);
    },
  );

  it.each(entries)("FOS1-PROP-04: %s's registry entry supplies a stubOutput", (agentKey, setup) => {
    expect(
      typeof setup.stubOutput,
      `${agentKey}: EVAL_AGENTS entry is missing stubOutput — a dry-run stub emitting no shape ` +
        "(or another agent's shape) fails stage-6 validation on every fixture, turning every " +
        "dry-run row into evaluation_failed: a harness that runs green while testing nothing.",
    ).toBe("function");
  });

  it.each(entries)(
    "FOS1-PROP-05: %s's stubOutput PARSES against its own output schema",
    (agentKey, setup) => {
      // FOS1-PROP-04 asserts the stub is a FUNCTION. It never asserted the
      // shape it returns, and that gap shipped a real break: #157 restructured
      // fos.call_preparation's output schema while its stub in EVAL_AGENTS kept
      // the flat shape, so `--dry-run` on main went to
      // {"evaluation_failed":7} — every row failing stage 6 — with the whole
      // suite green. A stub that cannot satisfy its own agent's schema is a
      // harness that runs and tests nothing.
      //
      // Driven with a REALISTIC minimal input, not an empty object. A stub is a
      // function of the PREPARED input, and `prepare` always supplies the
      // canonical entities — so requiring it to survive `{}` would test a shape
      // production never produces (and did: it threw on `input.opportunity`).
      //
      // What IS realistic, and is kept, is EMPTY EVIDENCE. A stub must tolerate
      // a fixture that supplies no evidence records, because it cites a
      // sourceRef the fixture provides. A stub that assumes evidence exists
      // fails on any fixture whose evidence is absent or spelled differently —
      // the live-run-1 failure shape.
      const output = setup.stubOutput({
        opportunity: { id: "00000000-0000-4000-8000-000000000001", stage: "reviewing" },
        person: { id: "00000000-0000-4000-8000-000000000002", firstName: "A", lastName: "B" },
        evidenceRecords: [],
        availableClaims: [],
      });
      const parsed = setup.definition.outputSchema.safeParse(output);
      expect(
        parsed.success,
        parsed.success
          ? ""
          : `${agentKey}: stubOutput does not satisfy the definition's outputSchema — ` +
              `--dry-run will report evaluation_failed for every fixture. Issues: ` +
              JSON.stringify(parsed.error.issues.slice(0, 5)),
      ).toBe(true);
    },
  );
});
