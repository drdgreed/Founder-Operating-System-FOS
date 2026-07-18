import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as schema from "../../schema/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/db/src/services/__tests__ -> packages/db/migrations
const MIGRATIONS_FOLDER = join(__dirname, "..", "..", "..", "migrations");

/**
 * Connects to a REAL Postgres server via `DATABASE_URL` (multiple concurrent
 * connections, unlike single-connection PGlite — see FOS0-ART-CC-*) and
 * applies every migration. `migrate` is idempotent (packages/db/src/migrate.ts),
 * so concurrent test files calling this against the same server is safe.
 * Callers MUST guard usage with `describe.skipIf(!process.env.DATABASE_URL)`.
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
