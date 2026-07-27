import Anthropic from "@anthropic-ai/sdk";

/** Default Sonnet model tier (ADR-07 §1, D1). */
export const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Retries the SDK performs per call (429 / 5xx, exponential backoff). Stated
 * explicitly so a caller wrapping this in a wall-clock timeout can size that
 * budget; inheriting the SDK default silently made the guarantee classifier's
 * 15s wrapper race a call that could legitimately take three attempts.
 */
export const ANTHROPIC_MAX_RETRIES = 2;

/**
 * Per-ATTEMPT timeout for a GENERATION call — an agent emitting a full
 * structured artifact, up to `max_tokens` 4096.
 *
 * This is the DEFAULT because it is the SAFE direction. P1.10j set a single
 * global per-attempt timeout of 12s, sized for the classifier's ~200-token
 * replies, on a client that also makes generation calls. Live run 4 then failed
 * 7 of 8 briefs at stage 5 with "Request timed out" at ~37s — exactly
 * 12s x (2 retries + 1) — having produced nothing at all. The one survivor
 * emitted 1014 output tokens and took 61s end to end.
 *
 * A caller that forgets to specify now gets a generous budget (works, possibly
 * slow) instead of a too-tight one (fails having produced nothing).
 */
export const ANTHROPIC_GENERATION_TIMEOUT_MS = 120_000;

/**
 * Per-ATTEMPT timeout for a CLASSIFIER call — a short verdict, ~200 output
 * tokens. Deliberately much smaller: the guarantee classifier fans out 12-20 of
 * these per run and fails closed on expiry, so a hung call must surrender
 * quickly rather than stall a whole review.
 *
 * Total wall clock for one classification is bounded by roughly
 * `ANTHROPIC_CLASSIFIER_TIMEOUT_MS * (ANTHROPIC_MAX_RETRIES + 1)` plus backoff,
 * which is what `GUARANTEE_CLASSIFIER_TIMEOUT_MS` is sized to exceed.
 */
export const ANTHROPIC_CLASSIFIER_TIMEOUT_MS = 12_000;

export interface GenerateStructuredInput {
  systemPrompt: string;
  userContent: string;
  /** JSON Schema the structured output must satisfy. */
  outputJsonSchema: Record<string, unknown>;
  model: string;
  /**
   * Per-ATTEMPT timeout for THIS call. Defaults to
   * `ANTHROPIC_GENERATION_TIMEOUT_MS`.
   *
   * Per call site rather than per client, because one client serves two very
   * different workloads: a generation call emits a full artifact (up to 4096
   * tokens, tens of seconds) while a classifier call emits a short verdict. A
   * single global value cannot serve both — sizing it for the classifier kills
   * generation, and sizing it for generation lets a hung classifier stall a
   * fan-out.
   */
  perAttemptTimeoutMs?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache on this call (billed at ~1.25x). */
  cacheCreationInputTokens?: number;
  /**
   * Tokens served FROM the prompt cache (billed at ~0.1x). The CLAUDE.md
   * Claude-API standard requires checking this before caching is called done:
   * a zero read-rate across repeated identical-prefix calls means a silent
   * invalidator, not a working cache.
   */
  cacheReadInputTokens?: number;
}

export interface GenerateStructuredResult {
  /** Parsed structured output — the runtime Zod-validates this at stage 6. */
  output: unknown;
  usage: ModelUsage;
}

/**
 * The #1 safety property (ADR-07, issue #50): injectable + REQUIRED, no
 * fallback to a real Anthropic call. `runAgent` takes a `ModelClient` as a
 * dependency; tests inject a fake and no real model call / spend can ever
 * happen in CI. Mirrors `NotionClient` (packages/notion/src/client.ts).
 */
export interface ModelClient {
  generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult>;
}

export type AnthropicFetchLike = typeof fetch;

export interface AnthropicModelClientOptions {
  /** Injected fetch — tests supply a mock; no real network in hermetic tests.
   * Mirrors NotionClientOptions.fetchImpl. */
  fetchImpl: AnthropicFetchLike;
  /** process.env var name holding the API key (credential reference, not the
   * secret itself — mirrors NotionClient.credentialReference / getToken).
   * Defaults to ANTHROPIC_API_KEY. */
  credentialReference?: string;
  baseUrl?: string;
}

/**
 * FLAG (genuinely underspecified in ADR-07/issue #50 — "the Anthropic
 * structured-output mechanism"): the Anthropic SDK offers no first-class
 * "JSON mode". The minimal defensible option implemented here is a
 * forced tool-use call — a single tool named `emit_structured_output` whose
 * `input_schema` is the definition's output JSON Schema, with
 * `tool_choice: {type: "tool", name: "emit_structured_output"}` so the model
 * MUST reply with a tool_use block conforming to the schema. This is
 * Anthropic's documented pattern for structured extraction. If a different
 * mechanism (e.g. a future native structured-output API) is preferred,
 * only this class needs to change — `ModelClient` is the stable seam.
 */
const STRUCTURED_OUTPUT_TOOL_NAME = "emit_structured_output";

export class AnthropicModelClient implements ModelClient {
  private readonly fetchImpl: AnthropicFetchLike;
  private readonly credentialReference: string;
  private readonly baseUrl: string | undefined;

  constructor(options: AnthropicModelClientOptions) {
    this.fetchImpl = options.fetchImpl;
    this.credentialReference = options.credentialReference ?? "ANTHROPIC_API_KEY";
    this.baseUrl = options.baseUrl;
  }

  /**
   * Reads the API key from process.env at CALL TIME via the credential
   * reference — never stored on a field, never logged, never included in a
   * thrown error (mirrors NotionClient.getToken exactly).
   */
  private getApiKey(): string {
    const apiKey = process.env[this.credentialReference];
    if (!apiKey) {
      throw new Error(`Anthropic credential reference "${this.credentialReference}" is not set`);
    }
    return apiKey;
  }

  async generateStructured(input: GenerateStructuredInput): Promise<GenerateStructuredResult> {
    const client = new Anthropic({
      apiKey: this.getApiKey(),
      fetch: this.fetchImpl,
      baseURL: this.baseUrl,
      // Make the retry budget EXPLICIT rather than inheriting the SDK default
      // and racing it from outside. The SDK retries 429/5xx with exponential
      // backoff, so one call to this method can be several attempts; callers
      // that wrap it in their own wall-clock timeout (the guarantee classifier
      // does) must be able to size that budget from a known number instead of
      // guessing. See DEFAULT_TIMEOUT_MS in gates/guarantee-classifier.ts for
      // the arithmetic.
      maxRetries: ANTHROPIC_MAX_RETRIES,
      timeout: input.perAttemptTimeoutMs ?? ANTHROPIC_GENERATION_TIMEOUT_MS,
    });

    const response = await client.messages.create({
      model: input.model,
      max_tokens: 4096,
      // System prompt is a fixed constant per caller (e.g.
      // GUARANTEE_CLASSIFIER_SYSTEM_PROMPT) reused across many calls with
      // different `userContent` — the ideal prompt-caching boundary. Render
      // order is tools -> system -> messages, so a cache_control breakpoint
      // on the last (only) system block caches tools + system together;
      // userContent after it is left uncached since it varies per request.
      //
      // UNCONDITIONAL on purpose. A prefix below the model's cacheable minimum
      // (1024 tokens on Sonnet 5) is silently ignored — no cache entry, and so
      // no ~1.25x write premium either. The breakpoint therefore costs nothing
      // where it cannot help, and starts helping automatically if a caller's
      // prefix later grows past the threshold. Gating it would be a switch for
      // turning off something free.
      //
      // Measured prefixes (tool schema + system prompt, ~4 chars/token):
      //   guarantee classifier        ~1081 tok — just over the minimum, and
      //                                called 12-20x per agent run with a
      //                                byte-identical prefix. The call site
      //                                that actually matters.
      //   agent def (enrollment_brief) ~542 tok — below the minimum today, so
      //                                the breakpoint is a no-op there. Not an
      //                                error; just not yet a benefit.
      //
      // The classifier's margin is ~5%, inside the error of a chars/4 estimate,
      // so whether it truly caches is UNKNOWN until observed. That is what
      // ModelUsage.cacheReadInputTokens below exists for — the CLAUDE.md
      // Claude-API standard requires checking it before caching is called done.
      system: [
        {
          type: "text",
          text: input.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: input.userContent }],
      tools: [
        {
          name: STRUCTURED_OUTPUT_TOOL_NAME,
          description: "Emit the run's structured result. Always call this exactly once.",
          input_schema: input.outputJsonSchema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL_NAME },
    });

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error("AnthropicModelClient: model response contained no tool_use block");
    }

    return {
      output: toolUse.input,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        // Surfaced so prompt caching can be VERIFIED rather than assumed. Note
        // `input_tokens` is the UNCACHED remainder only — total prompt size is
        // input + cache_creation + cache_read. A cost figure built on
        // `input_tokens` alone under-reports a cached call.
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
