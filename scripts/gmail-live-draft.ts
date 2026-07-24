/**
 * ONE-SHOT live validation for the Gmail-draft integration. It exercises the
 * REAL `GoogleGmailDraftClient` (the same class the worker wires in place of
 * `NotImplementedGmailDraftClient`) against the live Gmail REST API, creating a
 * single DRAFT (never sends). This is the last-mile check the in-suite contract
 * test structurally cannot do: proving a REAL token + scope + Google endpoint
 * accept the request the client builds.
 *
 * SECURITY: the OAuth2 access token is read from process.env.GMAIL_ACCESS_TOKEN
 * ONLY. This script never hardcodes, logs, or prints it — the request-logging
 * wrapper below redacts the Authorization header. Claude never sees the token;
 * you export it and run this yourself.
 *
 * Get a token: authorize the scope
 *   https://www.googleapis.com/auth/gmail.compose
 * (the scope Gmail's users.drafts.create lists) — e.g. via the OAuth 2.0
 * Playground — and copy the short-lived access token.
 *
 * Run from the repo root:
 *
 *   # credential-free preview — builds the request, no token, no network:
 *   npx tsx scripts/gmail-live-draft.ts --dry-run
 *
 *   # LIVE — creates one real draft in your Gmail Drafts (unsent):
 *    export GMAIL_ACCESS_TOKEN='<paste access token>'   # leading space keeps it out of shell history
 *   npx tsx scripts/gmail-live-draft.ts
 *   unset GMAIL_ACCESS_TOKEN
 *
 * Optional overrides (env): GMAIL_TO, GMAIL_SUBJECT, GMAIL_BODY.
 * Exit codes: 0 success · 1 the draft call failed · 2 no token supplied (live).
 */
import { GoogleGmailDraftClient, type GmailFetchLike } from "@fos/adapter";

const dryRun = process.argv.includes("--dry-run");

// In LIVE mode a real token is mandatory (fail closed). In --dry-run we never
// touch the network, so a placeholder lets you preview the built request with
// zero credentials.
let token = process.env.GMAIL_ACCESS_TOKEN;
if (!token || token.trim().length === 0) {
  if (!dryRun) {
    console.error(
      "✗ GMAIL_ACCESS_TOKEN is not set.\n" +
        "  Export a Gmail OAuth2 access token (scope: https://www.googleapis.com/auth/gmail.compose)\n" +
        "  and re-run, or pass --dry-run to preview the request with no token.",
    );
    process.exit(2);
  }
  token = "dry-run-placeholder-token";
}

const to = process.env.GMAIL_TO ?? "fos-live-check@example.com";
const subject = process.env.GMAIL_SUBJECT ?? "FOS live check — GoogleGmailDraftClient";
const body =
  process.env.GMAIL_BODY ??
  "This draft was created by scripts/gmail-live-draft.ts to validate the FOS " +
    "GoogleGmailDraftClient against the live Gmail API. It was never sent.";

/**
 * A fetch wrapper that logs a REDACTED request line (never the token), then in
 * --dry-run short-circuits with a synthetic 200 (no network) so the client's
 * encode + response-parse paths still run end-to-end. In LIVE mode it delegates
 * to the real global fetch.
 */
const loggingFetch: GmailFetchLike = async (url, init) => {
  console.log(`\n[request] ${init?.method ?? "GET"} ${url}`);
  console.log("[headers] Authorization: Bearer <redacted>  |  Content-Type: application/json");

  if (dryRun) {
    const raw = (JSON.parse(String(init?.body ?? "{}")) as { message?: { raw?: string } }).message
      ?.raw;
    if (raw) {
      console.log("[dry-run] no network call. Decoded RFC 5322 message:\n");
      console.log(Buffer.from(raw, "base64url").toString("utf8"));
    }
    return new Response(JSON.stringify({ id: "dry-run-synthetic-draft-id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return fetch(url, init);
};

async function main(): Promise<void> {
  const client = new GoogleGmailDraftClient({
    // Read once for this one-shot run. `token` is guaranteed non-empty here.
    getAccessToken: () => token as string,
    fetchImpl: loggingFetch,
  });

  console.log(
    `Creating a Gmail draft (${dryRun ? "DRY RUN — no network" : "LIVE"}):\n` +
      `  to:      ${to}\n` +
      `  subject: ${subject}`,
  );

  const result = await client.createDraft({ to, subject, body });

  if (dryRun) {
    console.log(
      `\n✅ DRY RUN OK — the client built a valid request and parsed a draft id ` +
        `(synthetic: ${result.draftId}).\n   Re-run without --dry-run and with GMAIL_ACCESS_TOKEN set to create a real draft.`,
    );
  } else {
    console.log(
      `\n✅ LIVE OK — real draft created (unsent) in your Gmail Drafts.\n` +
        `   draft id: ${result.draftId}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(`\n✗ FAILED: ${err instanceof Error ? err.message : String(err)}`);
  // A 403 here almost always means the token lacks the gmail.compose scope.
  process.exit(1);
});
