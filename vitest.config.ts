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
          // Re-state vitest's default excludes (an explicit `exclude` replaces
          // them) — `**/dist/**` etc. — plus the db partition so a stray built
          // `dist/*.test.ts` can never be picked up here.
          exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "**/.{idea,git,cache,output,temp}/**",
            "packages/db/**",
            "packages/adapter/**",
          ],
          environment: "node",
        },
      },
      // @fos/db + @fos/adapter projects: concurrency is capped inside each
      // package's vitest.config.ts to avoid parallel fresh-PGlite contention
      // (issue #72). Scoped to those packages only; all others stay parallel.
      "./packages/db/vitest.config.ts",
      "./packages/adapter/vitest.config.ts",
    ],
  },
});
