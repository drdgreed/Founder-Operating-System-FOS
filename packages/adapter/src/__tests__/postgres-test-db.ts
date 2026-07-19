import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "@fos/db/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/adapter/src/__tests__ -> packages/db/migrations
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "..", "db", "migrations");

/**
 * Mirrors `packages/db/src/services/__tests__/postgres-db.ts` for this
 * package's own tests (issue #38 item 2 — a true-concurrency test needs
 * multiple real connections, unlike single-connection PGlite). Callers MUST
 * guard usage with `describe.skipIf(!process.env.DATABASE_URL)`.
 */
export async function createRealPgTestDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("createRealPgTestDb: DATABASE_URL is not set; guard callers with skipIf.");
  }
  const sql = postgres(url, { max: 10 });
  const db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    db,
    close: () => sql.end(),
  };
}
