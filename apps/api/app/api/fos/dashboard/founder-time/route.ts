import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import {
  requireServiceAuth,
  UnauthorizedError,
  ServiceUnconfiguredError,
  type Principal,
} from "../../../../../lib/auth.js";
import { getFounderTime } from "../../../../../lib/dashboards.js";

/**
 * `GET /api/fos/dashboard/founder-time` (spec §7.2 / §9.4 step 8). Read-only
 * founder-time instrumentation: counts of decisions (operational_event), agent
 * runs, and interactions over an optional `?from=&to=` ISO-8601 window. Thin
 * adapter: authenticate → parse window from the query → delegate. The workspace
 * is bound from the authenticated principal; an unparseable window → 400.
 */
export async function GET(req: NextRequest) {
  let principal: Principal;
  try {
    principal = requireServiceAuth(req);
  } catch (err) {
    if (err instanceof ServiceUnconfiguredError) {
      return NextResponse.json({ error: "service unavailable" }, { status: 503 });
    }
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }

  const params = req.nextUrl.searchParams;
  const rawWindow = {
    ...(params.has("from") ? { from: params.get("from") } : {}),
    ...(params.has("to") ? { to: params.get("to") } : {}),
  };

  try {
    const result = await getFounderTime(getDb(), principal, rawWindow);
    return NextResponse.json(result.body, { status: result.status });
  } catch {
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
