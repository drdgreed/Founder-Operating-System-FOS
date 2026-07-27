/**
 * Measure how long a REAL guarantee-classifier call actually takes.
 *
 * WHY THIS EXISTS
 * `ANTHROPIC_CLASSIFIER_TIMEOUT_MS` and `GUARANTEE_CLASSIFIER_TIMEOUT_MS` have
 * never been measured. Both were derived arithmetic, and both have now caused a
 * production-shaped failure:
 *   - run 3: the 15s wrapper raced an SDK retry loop it did not know about, and
 *     four briefs recorded TIMEOUTS AS COMPLIANCE VERDICTS.
 *   - run 4: a 12s per-attempt timeout, sized for the classifier, was set on the
 *     SHARED client and starved generation (P-005).
 *   - run 6: that same 12s proved too small for the classifier itself once its
 *     prompt grew ~31%, and 7 of 8 briefs blocked on "Request timed out."
 * Three failures from two numbers nobody measured. This probe replaces the guess.
 *
 * WHAT IT MEASURES, AND WHY IN TWO PHASES
 * A single warm sequential call and a burst at production concurrency answer two
 * DIFFERENT questions, and confusing them is how the wrong knob gets turned:
 *   phase 1 (sequential) — how long does ONE call take with no contention?
 *                          This is the floor the per-attempt timeout must clear.
 *   phase 2 (concurrent) — how long does a call take under the fan-out the
 *                          pipeline actually runs (DEFAULT_COMPLIANCE_REVIEW_
 *                          CONCURRENCY)? If phase 2 is much worse than phase 1,
 *                          the problem is contention and CONCURRENCY is the
 *                          lever. If they are similar, the call is simply slow
 *                          and the TIMEOUT is the lever.
 *
 * The FIRST call is reported separately because it pays the prompt-cache WRITE,
 * which is slower than the reads every later call gets. Averaging it in would
 * understate the steady state and overstate the worst case at the same time.
 *
 * SAFETY: `--live` is REQUIRED and is the only mode. There is nothing to stub —
 * a stubbed latency measurement is not a measurement. Cost is ~$0.01 for the
 * default 12 calls.
 *
 * USAGE
 *   npx tsx --env-file=.env scripts/classifier-latency-probe.ts --live
 *   npx tsx --env-file=.env scripts/classifier-latency-probe.ts --live -n 20
 */
import { AnthropicModelClient } from "../packages/agents/src/model-client.js";
import {
  classifyGuarantee,
  GUARANTEE_CLASSIFIER_TIMEOUT_MS,
} from "../packages/agents/src/gates/guarantee-classifier.js";
import {
  ANTHROPIC_CLASSIFIER_TIMEOUT_MS,
  ANTHROPIC_MAX_RETRIES,
} from "../packages/agents/src/model-client.js";
import { DEFAULT_COMPLIANCE_REVIEW_CONCURRENCY } from "../packages/agents/src/pipeline.js";
import { GUARANTEE_CORPUS } from "../packages/agents/src/gates/__tests__/guarantee-corpus.js";
import { stripEmptyAnthropicEnv } from "./eval-run.js";

interface Sample {
  index: number;
  ms: number;
  verdict: string;
  cacheRead: number;
  cacheWrite: number;
  error?: string;
}

/**
 * A generous per-call budget for the PROBE only — deliberately far above the
 * production value. The probe must observe how long a slow call really takes;
 * inheriting the production timeout would censor exactly the tail we are trying
 * to measure and report it as an error.
 */
const PROBE_TIMEOUT_MS = 180_000;

async function timeOne(index: number, text: string, model: AnthropicModelClient): Promise<Sample> {
  const startedAt = Date.now();
  try {
    const decision = await classifyGuarantee(text, { model, timeoutMs: PROBE_TIMEOUT_MS });
    return {
      index,
      ms: Date.now() - startedAt,
      verdict: decision.verdict,
      cacheRead: decision.usage?.cacheReadInputTokens ?? 0,
      cacheWrite: decision.usage?.cacheCreationInputTokens ?? 0,
    };
  } catch (err) {
    return {
      index,
      ms: Date.now() - startedAt,
      verdict: "ERROR",
      cacheRead: 0,
      cacheWrite: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarise(label: string, samples: Sample[]): void {
  const ok = samples.filter((s) => s.verdict !== "ERROR");
  if (ok.length === 0) {
    console.log(`${label}: all ${samples.length} call(s) FAILED`);
    for (const s of samples) console.log(`  #${s.index}: ${s.error}`);
    return;
  }
  const sorted = [...ok].map((s) => s.ms).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  console.log(
    `${label}: n=${ok.length} min=${sorted[0]}ms p50=${at(0.5)}ms p90=${at(0.9)}ms max=${sorted[sorted.length - 1]}ms` +
      (samples.length > ok.length ? `  (${samples.length - ok.length} FAILED)` : ""),
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes("--live")) {
    console.error(
      "classifier-latency-probe: --live is REQUIRED and is the only mode (this SPENDS MONEY).\n" +
        "classifier-latency-probe: a stubbed latency measurement is not a measurement.",
    );
    process.exit(2);
  }
  const nIndex = argv.indexOf("-n");
  const count = nIndex === -1 ? 12 : Number(argv[nIndex + 1] ?? "12");

  const stripped = stripEmptyAnthropicEnv();
  if (stripped.length > 0) {
    console.error(
      `classifier-latency-probe: removed ${stripped.length} EMPTY ${stripped.join(", ")} var(s) (L-007).`,
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "classifier-latency-probe: --live requires a non-empty ANTHROPIC_API_KEY.\n" +
        "classifier-latency-probe:   npx tsx --env-file=.env scripts/classifier-latency-probe.ts --live\n" +
        "classifier-latency-probe: Run from a REAL terminal — a Claude Code shell exports empty ANTHROPIC_* vars (L-007).",
    );
    process.exit(2);
  }

  // Real corpus texts, so the measurement reflects real input lengths rather
  // than a synthetic short string that would time faster than production.
  const texts = Array.from(
    { length: count },
    (_, i) => GUARANTEE_CORPUS[i % GUARANTEE_CORPUS.length]!.text,
  );
  const model = new AnthropicModelClient({ fetchImpl: fetch });

  console.log(
    `classifier-latency-probe: ${count} call(s). Current settings — per-attempt ` +
      `${ANTHROPIC_CLASSIFIER_TIMEOUT_MS}ms x ${ANTHROPIC_MAX_RETRIES + 1} attempts, ` +
      `wrapper ${GUARANTEE_CLASSIFIER_TIMEOUT_MS}ms, production concurrency ${DEFAULT_COMPLIANCE_REVIEW_CONCURRENCY}.`,
  );
  console.log(
    `classifier-latency-probe: probe budget is ${PROBE_TIMEOUT_MS}ms so the tail is not censored.\n`,
  );

  // --- Phase 1: sequential, no contention ---------------------------------
  const sequential: Sample[] = [];
  for (let i = 0; i < Math.min(4, count); i++) {
    const sample = await timeOne(i, texts[i]!, model);
    sequential.push(sample);
    console.log(
      `  seq #${i}: ${sample.ms}ms  verdict=${sample.verdict}  ` +
        `cache read=${sample.cacheRead} write=${sample.cacheWrite}` +
        (sample.error ? `  ERROR: ${sample.error}` : "") +
        (i === 0 ? "   <- FIRST CALL: pays the cache WRITE, expected to be slowest" : ""),
    );
  }
  console.log("");
  summarise("SEQUENTIAL (no contention)", sequential);
  summarise("SEQUENTIAL excluding the cache-write call", sequential.slice(1));

  // --- Phase 2: burst at the production concurrency ------------------------
  const remaining = texts.slice(sequential.length);
  const concurrent: Sample[] = [];
  let cursor = 0;
  const startedAt = Date.now();
  await Promise.all(
    Array.from(
      { length: Math.min(DEFAULT_COMPLIANCE_REVIEW_CONCURRENCY, remaining.length) },
      async () => {
        for (;;) {
          const index = cursor++;
          if (index >= remaining.length) return;
          concurrent.push(await timeOne(sequential.length + index, remaining[index]!, model));
        }
      },
    ),
  );
  const wall = Date.now() - startedAt;
  console.log("");
  summarise(
    `CONCURRENT (${DEFAULT_COMPLIANCE_REVIEW_CONCURRENCY}-way, as the pipeline runs it)`,
    concurrent,
  );
  console.log(`  wall clock for the burst: ${wall}ms`);

  // --- The recommendation --------------------------------------------------
  const all = [...sequential, ...concurrent].filter((s) => s.verdict !== "ERROR");
  const failures = [...sequential, ...concurrent].filter((s) => s.verdict === "ERROR");
  if (all.length === 0) {
    console.log("\nclassifier-latency-probe: every call failed — nothing to recommend.");
    process.exit(1);
  }
  const worst = Math.max(...all.map((s) => s.ms));
  const recommendedPerAttempt = Math.ceil((worst * 2) / 5_000) * 5_000;
  const recommendedWrapper =
    Math.ceil((recommendedPerAttempt * (ANTHROPIC_MAX_RETRIES + 1) * 1.2) / 10_000) * 10_000;

  console.log(
    `\nclassifier-latency-probe: worst observed healthy call ${worst}ms across ${all.length} sample(s).`,
  );
  if (failures.length > 0) {
    console.log(
      `classifier-latency-probe: ${failures.length} call(s) FAILED even at the ${PROBE_TIMEOUT_MS}ms probe budget:`,
    );
    for (const f of failures) console.log(`  #${f.index}: ${f.error}`);
  }
  console.log(
    `classifier-latency-probe: 2x headroom => ANTHROPIC_CLASSIFIER_TIMEOUT_MS ${recommendedPerAttempt}, ` +
      `GUARANTEE_CLASSIFIER_TIMEOUT_MS ${recommendedWrapper} (wrapper must exceed per-attempt x ${ANTHROPIC_MAX_RETRIES + 1}).`,
  );
  console.log(
    `classifier-latency-probe: currently ${ANTHROPIC_CLASSIFIER_TIMEOUT_MS} / ${GUARANTEE_CLASSIFIER_TIMEOUT_MS}. ` +
      (recommendedPerAttempt > ANTHROPIC_CLASSIFIER_TIMEOUT_MS
        ? "RAISE THEM — the current per-attempt value is below the measured need."
        : "The current values clear the measurement."),
  );
  console.log(
    "classifier-latency-probe: if CONCURRENT p90 is far above SEQUENTIAL p90, the bottleneck is contention and\n" +
      "classifier-latency-probe: DEFAULT_COMPLIANCE_REVIEW_CONCURRENCY is the lever instead. Turn ONE knob (F-M).",
  );
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error("classifier-latency-probe: FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
