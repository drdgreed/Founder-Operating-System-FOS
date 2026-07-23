import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db.js";
import {
  requireServiceAuth,
  UnauthorizedError,
  ServiceUnconfiguredError,
  type Principal,
} from "../../../../../lib/auth.js";
import { getAttribution } from "../../../../../lib/dashboards.js";

/**
 * `GET /api/fos/dashboard/attribution` (spec §7.2 / §9.4 step 8). Read-only
 * campaign-attribution aggregate: per-campaign touch counts joined to funnel
 * outcomes (enrollments). Thin adapter: authenticate → delegate. The workspace
 * is bound from the authenticated principal; campaign_touch is scoped
 * transitively via campaign.workspace_id.
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
    const body = await getAttribution(getDb(), principal);
    return NextResponse.json(body, { status: 200 });
  } catch {
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
