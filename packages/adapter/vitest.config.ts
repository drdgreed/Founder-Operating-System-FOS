import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "adapter",
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Cap concurrency for the @fos/adapter package only (issue #72 — same class
    // #100 fixed for @fos/db, extended here). The adapter's projection /
    // reconcile / execute-stage-command tests each spin up a fresh in-memory
    // PGlite (WASM Postgres) instance; under full file-parallelism across the
    // whole repo suite, they contend with every other package's fresh-PGlite
    // tests and intermittently fail (e.g. reconcile FOS0-RCN-05,
    // execute-stage-commands FOS0-EXE-01). Each passes in isolation — resource
    // contention, not a code defect. Serializing the adapter files removes it.
    // Scoped to this package via the root vitest.config projects entry; all
    // other packages keep full parallelism.
    fileParallelism: false,
  },
});
