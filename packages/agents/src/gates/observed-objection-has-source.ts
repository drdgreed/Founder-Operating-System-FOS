import type { Gate, GateContext, GateResult } from "./gate.js";

export interface ObservedObjectionHasSourceGateOptions<TInput, TOutput> {
  key: string;
  /** Selects the structured (already-validated) `objections`-shaped entries. */
  selectObjections: (
    output: TOutput,
  ) => ReadonlyArray<{ classification: string; sourceRef?: string }>;
  /** Selects every `sourceRef` value present in the run's own input context
   * (evidence/source records the agent was given to reason over). */
  selectValidSourceRefs: (input: TInput) => ReadonlyArray<string>;
  /** The `classification` value that requires a resolvable source (e.g.
   * `"observed"`). Any other classification (e.g. `"inferred"`) is exempt. */
  observedValue: string;
}

/**
 * Objection Intelligence Agent hard gate (issue #73, spec §8.5): "Aggregate
 * dashboards use reviewed observed objections by default" — so an "observed"
 * objection with no resolvable source is a fabricated observation, the exact
 * thing the observed/inferred split exists to prevent. Every objection with
 * `classification === observedValue` must carry a `sourceRef` that names a
 * source record actually present in the run's own input context — never a
 * source the model invented, and never simply absent. Modeled generically
 * (mirrors `factsResolveToSourcesGate`'s shape) rather than hardcoded to
 * "observed"/objections so the same gate shape could serve a future agent
 * with an analogous observed/inferred split. Reads only the Zod-validated
 * `input`/`output` (D9): not steerable by anything in free-text transcript
 * content. `inferred` objections are exempt — they carry a `confidence`
 * instead and structurally need no source.
 */
export function observedObjectionHasSourceGate<TInput, TOutput>(
  options: ObservedObjectionHasSourceGateOptions<TInput, TOutput>,
): Gate<TInput, TOutput> {
  return {
    key: options.key,
    evaluate(ctx: GateContext<TInput, TOutput>): GateResult {
      const validRefs = new Set(options.selectValidSourceRefs(ctx.input));
      const objections = options.selectObjections(ctx.output);
      const unsourced = objections.find(
        (o) =>
          o.classification === options.observedValue &&
          (!o.sourceRef || !validRefs.has(o.sourceRef)),
      );
      if (unsourced) {
        return {
          allowed: false,
          reason: `observed objection has no resolvable sourceRef: "${unsourced.sourceRef ?? "(none)"}"`,
        };
      }
      return { allowed: true };
    },
  };
}
