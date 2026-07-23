import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import {
  requireServiceAuth,
  UnauthorizedError,
  ServiceUnconfiguredError,
  type Principal,
} from "../../../../../lib/auth.js";
import { getFunnel } from "../../../../../lib/dashboards.js";

/**
 * `GET /api/fos/dashboard/funnel` (spec §7.2 / §9.4 step 8). Read-only
 * opportunity-funnel aggregate. Thin adapter: authenticate → delegate to
 * `getFunnel`. The workspace is bound from the authenticated principal, never
 * the request — every aggregation query is scoped to it.
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

  try {
    const body = await getFunnel(getDb(), principal);
    return NextResponse.json(body, { status: 200 });
  } catch {
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
