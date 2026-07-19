import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { NotionClient, type FetchLike } from "@fos/notion";
import {
  intakeApplication,
  createArtifact,
  recordApprovalDecision,
  transitionArtifactVersionStatus,
} from "@fos/db/services";
import {
  fosWorkspace,
  product,
  enrollmentOpportunity,
  artifactRecord,
  artifactVersion,
  approval,
  projection,
} from "@fos/db/schema";
import { projectOpportunity } from "../project-opportunity.js";
import { createTestDb } from "./test-db.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeMockNotion(nextPageId = "notion-page-1") {
  const fetchImpl: FetchLike = async (path, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && path.endsWith("/pages")) {
      return jsonResponse(200, { object: "page", id: nextPageId });
    }
    if (method === "PATCH" && path.includes("/pages/")) {
      return jsonResponse(200, { object: "page", id: path.split("/pages/")[1] });
    }
    throw new Error(`unexpected call in mock: ${method} ${path}`);
  };
  return new NotionClient({ fetchImpl, requestsPerSecond: 100 });
}

/**
 * P1.0 (issue #48) Phase-0 reuse verification — ADR-07 D6 asserts Phase 1
 * builds ON these Phase-0 services rather than re-creating them. This proves
 * the full chain still composes end to end BEFORE the P1.1 runtime slice
 * builds on top of it: intake (seeds Person + EnrollmentOpportunity) ->
 * artifact-service (creates an ArtifactRecord + v1 ArtifactVersion) ->
 * approval-service (records a human-gate decision, driving the version to
 * `approved`) -> projectOpportunity (projects the opportunity to its Notion
 * page). Each step's canonical write is asserted, and each step's output
 * feeds the next (no service is re-implemented or bypassed).
 */
describe("Phase-0 service composition (ADR-07 D6, issue #48 P1.0)", () => {
  const originalToken = process.env.FOS_NOTION_TOKEN;

  beforeEach(() => {
    process.env.FOS_NOTION_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.FOS_NOTION_TOKEN;
    else process.env.FOS_NOTION_TOKEN = originalToken;
  });

  it("FOS1-COMPOSE-01: intake -> artifact-service -> approval-service -> projectOpportunity chains end to end", async () => {
    const { db, close } = await createTestDb();
    try {
      const [workspace] = await db
        .insert(fosWorkspace)
        .values({ name: "Test Workspace", ownerUserId: "founder-1" })
        .returning();
      if (!workspace) throw new Error("fos_workspace insert returned no row");

      const [prod] = await db
        .insert(product)
        .values({
          workspaceId: workspace.id,
          productKey: "career-foundry",
          name: "Career Foundry",
          productType: "product",
          parentProductId: null,
        })
        .returning();
      if (!prod) throw new Error("product insert returned no row");

      // 1. Intake: seeds Person + EnrollmentOpportunity + ApplicationSubmission
      // (reused as-is from Phase 0 — issue #48 builds no parallel intake path).
      const intake = await intakeApplication(db, {
        workspaceId: workspace.id,
        productId: prod.id,
        actor: { type: "founder", id: "founder-1" },
        person: {
          firstName: "Grace",
          lastName: "Hopper",
          email: "grace@example.com",
          source: "website_application",
        },
        application: {
          formVersion: "v1",
          rawPayloadJson: { answers: { goal: "career change" } },
          sourceReference: "web-form",
        },
      });
      expect(intake.deduped).toBe(false);
      expect(intake.opportunityId).toBeTruthy();

      const [opportunityRow] = await db
        .select()
        .from(enrollmentOpportunity)
        .where(eq(enrollmentOpportunity.id, intake.opportunityId));
      expect(opportunityRow).toMatchObject({
        id: intake.opportunityId,
        workspaceId: workspace.id,
        productId: prod.id,
        personId: intake.personId,
      });

      // 2. artifact-service: create an ArtifactRecord + v1 ArtifactVersion
      // (e.g. the future enrollment_brief artifact type — reused generically).
      const created = await createArtifact(db, {
        workspaceId: workspace.id,
        productId: prod.id,
        artifactType: "internal_note",
        domain: "enrollment",
        title: "Enrollment brief (P1.0 composition check)",
        bodyMarkdown: "# Candidate summary\nSeeded for Phase-0 reuse verification.",
        actor: { type: "agent", id: "fos.enrollment_brief" },
        correlationId: intake.correlationId ?? undefined,
        causationId: intake.eventIds[intake.eventIds.length - 1],
      });
      expect(created.status).toBe("draft");

      const [artifactRow] = await db
        .select()
        .from(artifactRecord)
        .where(eq(artifactRecord.id, created.artifactId));
      expect(artifactRow).toMatchObject({
        id: created.artifactId,
        workspaceId: workspace.id,
        currentVersionId: created.versionId,
        status: "draft",
      });
      const [versionRow] = await db
        .select()
        .from(artifactVersion)
        .where(eq(artifactVersion.id, created.versionId));
      expect(versionRow).toMatchObject({ id: created.versionId, approvalStatus: "draft" });

      // Move the version to `in_review` (the decidable state) via the reused
      // transition path, mirroring how a real approval-request would arrive.
      await transitionArtifactVersionStatus(db, {
        versionId: created.versionId,
        expectedStatus: "draft",
        toStatus: "in_review",
        actor: { type: "founder", id: "founder-1" },
      });

      // 3. approval-service: record a human-gate decision on that version.
      const decision = await recordApprovalDecision(db, {
        artifactVersionId: created.versionId,
        decision: "approved",
        riskLevel: "low",
        actor: { type: "founder", id: "founder-1" },
      });
      expect(decision.status).toBe("approved");

      const [approvalRow] = await db
        .select()
        .from(approval)
        .where(eq(approval.id, decision.approvalId));
      expect(approvalRow).toMatchObject({
        artifactVersionId: created.versionId,
        status: "approved",
        riskLevel: "low",
      });
      const [approvedVersion] = await db
        .select()
        .from(artifactVersion)
        .where(eq(artifactVersion.id, created.versionId));
      expect(approvedVersion?.approvalStatus).toBe("approved");

      // 4. projectOpportunity: project the SAME opportunity intake produced to
      // its Notion page (0.2b, reused unmodified).
      const client = makeMockNotion("notion-page-composition");
      const opportunity = opportunityRow!;
      const projected = await projectOpportunity(db, client, {
        opportunity,
        dataSourceId: "data-source-1",
      });
      expect(projected.created).toBe(true);
      expect(projected.providerPageId).toBe("notion-page-composition");

      const [projectionRow] = await db
        .select()
        .from(projection)
        .where(
          and(
            eq(projection.workspaceId, workspace.id),
            eq(projection.entityType, "EnrollmentOpportunity"),
            eq(projection.entityId, intake.opportunityId),
            eq(projection.provider, "notion"),
          ),
        );
      expect(projectionRow).toMatchObject({
        providerPageId: "notion-page-composition",
        syncStatus: "in_sync",
      });

      // The chain: one Person/Opportunity from intake, one ArtifactRecord+Version
      // approved against it, and one Notion projection of that same opportunity.
      expect(projectionRow?.entityId).toBe(opportunityRow!.id);
    } finally {
      await close();
    }
  });
});
