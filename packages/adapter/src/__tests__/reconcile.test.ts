import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { NotionClient, type FetchLike } from "@fos/notion";
import { projection } from "@fos/db/schema";
import { reconcile } from "../reconcile.js";
import { createTestDb, seedOpportunity } from "./test-db.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

interface CannedPage {
  id: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
}

/**
 * Builds a canned Notion page. `fosVersion: null` OMITS the `FOS Version`
 * property entirely (the unreadable-stamp case); a number sets it.
 */
function buildPage(input: {
  pageId: string;
  fosRecordId: string | null;
  fosVersion?: number | null;
}): CannedPage {
  const properties: Record<string, unknown> = {
    "FOS Record ID":
      input.fosRecordId === null
        ? { rich_text: [] }
        : { rich_text: [{ plain_text: input.fosRecordId }] },
  };
  const version = input.fosVersion === undefined ? 1 : input.fosVersion;
  if (version !== null) properties["FOS Version"] = { number: version };
  return {
    id: input.pageId,
    last_edited_time: "2026-07-18T13:00:00Z",
    properties,
  };
}

/** Mock NotionClient whose `queryDataSource` returns a fixed, injected page list. */
function makeMockNotion(pages: CannedPage[]) {
  const fetchImpl: FetchLike = async (path, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && path.includes("/query")) {
      return jsonResponse(200, { results: pages, has_more: false, next_cursor: null });
    }
    throw new Error(`unexpected call in mock: ${method} ${path}`);
  };
  return new NotionClient({ fetchImpl, requestsPerSecond: 100 });
}

type SyncStatus =
  "pending" | "in_sync" | "fos_ahead" | "provider_ahead" | "conflict" | "failed" | "disabled";

async function seedProjection(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  input: {
    workspaceId: string;
    productId: string | null;
    entityId: string;
    providerPageId: string;
    fosVersion: number;
    syncStatus?: SyncStatus;
  },
) {
  const [row] = await db
    .insert(projection)
    .values({
      workspaceId: input.workspaceId,
      productId: input.productId,
      entityType: "EnrollmentOpportunity",
      entityId: input.entityId,
      provider: "notion",
      providerPageId: input.providerPageId,
      syncStatus: input.syncStatus ?? "in_sync",
      fosVersion: input.fosVersion,
      lastSyncedAt: new Date("2026-07-18T12:00:00Z"),
    })
    .returning();
  if (!row) throw new Error("seedProjection: projection insert returned no row");
  return row;
}

async function readProjection(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  entityId: string,
) {
  const [proj] = await db.select().from(projection).where(eq(projection.entityId, entityId));
  return proj;
}

describe("reconcile (issue #30, slice 0.2c — inbound integrity check)", () => {
  const originalToken = process.env.FOS_NOTION_TOKEN;

  beforeEach(() => {
    process.env.FOS_NOTION_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.FOS_NOTION_TOKEN;
    else process.env.FOS_NOTION_TOKEN = originalToken;
  });

  it("FOS0-RCN-05: page FOS Version matches canonical -> inSync; a non-in_sync projection state is NOT clobbered", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 3 });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: opportunity.version,
        // A state a future 0.2d capture flow might set — reconcile must leave it.
        syncStatus: "provider_ahead",
      });
      const page = buildPage({
        pageId: "notion-page-1",
        fosRecordId: opportunity.id,
        fosVersion: 3,
      });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.inSync).toBe(1);
      expect(result.conflicts).toBe(0);
      // Version matched -> reconcile wrote nothing, so the seeded state stands.
      expect((await readProjection(db, opportunity.id))!.syncStatus).toBe("provider_ahead");
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-06: page FOS Version differs from canonical (§8.3 stale projection) -> conflict, no overwrite", async () => {
    const { db, close } = await createTestDb();
    try {
      // Canonical has advanced to v2 since projection; the page still stamps v1.
      const { opportunity } = await seedOpportunity(db, { version: 2 });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
        syncStatus: "in_sync",
      });
      const page = buildPage({
        pageId: "notion-page-1",
        fosRecordId: opportunity.id,
        fosVersion: 1,
      });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.conflicts).toBe(1);
      expect(result.inSync).toBe(0);
      expect((await readProjection(db, opportunity.id))!.syncStatus).toBe("conflict");
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-07: an unreadable page FOS Version is treated as a conflict, never assumed in-sync", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1 });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
        syncStatus: "in_sync",
      });
      // fosVersion: null -> the FOS Version property is omitted from the page.
      const page = buildPage({
        pageId: "notion-page-1",
        fosRecordId: opportunity.id,
        fosVersion: null,
      });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.conflicts).toBe(1);
      expect((await readProjection(db, opportunity.id))!.syncStatus).toBe("conflict");
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-08: reconcile is stable across repeated runs (idempotent detection, no side effects)", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1 });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
        syncStatus: "in_sync",
      });
      const page = buildPage({
        pageId: "notion-page-1",
        fosRecordId: opportunity.id,
        fosVersion: 1,
      });
      const client = makeMockNotion([page]);
      const args = { workspaceId: opportunity.workspaceId, dataSourceId: "data-source-1" };

      const first = await reconcile(db, client, args);
      const second = await reconcile(db, client, args);

      expect(first.inSync).toBe(1);
      expect(second.inSync).toBe(1);
      expect(second.conflicts).toBe(0);
      // Exactly one projection row throughout — no accidental inserts/dups.
      expect(await db.select().from(projection)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-09: duplicate FOS Record ID across two pages -> conflict, neither copy version-checked", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1 });
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: opportunity.id,
        providerPageId: "notion-page-1",
        fosVersion: 1,
        syncStatus: "in_sync",
      });
      // Two distinct pages sharing one FOS Record ID (0.2b dual-write window).
      const pageA = buildPage({
        pageId: "notion-page-1",
        fosRecordId: opportunity.id,
        fosVersion: 1,
      });
      const pageB = buildPage({
        pageId: "notion-page-2",
        fosRecordId: opportunity.id,
        fosVersion: 1,
      });
      const client = makeMockNotion([pageA, pageB]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.duplicateEntityIds).toEqual([opportunity.id]);
      expect(result.conflicts).toBe(1);
      expect(result.inSync).toBe(0);
      expect((await readProjection(db, opportunity.id))!.syncStatus).toBe("conflict");
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-10: a page whose FOS Record ID has no projection row -> orphan, no crash", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1 });
      // No projection row is seeded for this opportunity at all.
      const page = buildPage({
        pageId: "notion-page-orphan",
        fosRecordId: opportunity.id,
        fosVersion: 1,
      });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.orphans).toBe(1);
      expect(result.conflicts).toBe(0);
      expect(await db.select().from(projection)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-11: a page with no parseable FOS Record ID -> orphan, not crashed on", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1 });
      const page = buildPage({ pageId: "notion-page-blank", fosRecordId: null });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.orphans).toBe(1);
      expect(result.conflicts).toBe(0);
    } finally {
      await close();
    }
  });

  it("FOS0-RCN-12: a projection pointing at a deleted canonical opportunity -> orphan, no crash", async () => {
    const { db, close } = await createTestDb();
    try {
      const { opportunity } = await seedOpportunity(db, { version: 1 });
      // A projection whose FOS Record ID has no matching enrollment_opportunity.
      const danglingEntityId = "00000000-0000-0000-0000-0000000000ff";
      await seedProjection(db, {
        workspaceId: opportunity.workspaceId,
        productId: opportunity.productId,
        entityId: danglingEntityId,
        providerPageId: "notion-page-dangling",
        fosVersion: 1,
        syncStatus: "in_sync",
      });
      const page = buildPage({
        pageId: "notion-page-dangling",
        fosRecordId: danglingEntityId,
        fosVersion: 1,
      });
      const client = makeMockNotion([page]);

      const result = await reconcile(db, client, {
        workspaceId: opportunity.workspaceId,
        dataSourceId: "data-source-1",
      });

      expect(result.orphans).toBe(1);
      expect(result.conflicts).toBe(0);
    } finally {
      await close();
    }
  });
});
