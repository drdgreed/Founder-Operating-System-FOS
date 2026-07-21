import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Default project: every package/app EXCEPT @fos/db, with vitest's
        // normal full file-parallelism. Behavior here is unchanged from before.
        test: {
          name: "default",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
          exclude: ["**/node_modules/**", "packages/db/**"],
          environment: "node",
        },
      },
      // @fos/db project: concurrency is capped inside packages/db/vitest.config.ts
      // to avoid parallel fresh-PGlite contention (issue #72). Scoped to db only.
      "./packages/db/vitest.config.ts",
    ],
  },
});
