import { defineConfig } from "vitest/config";
import { dbUrl } from "./test/config";

// Three tiers with different lifecycles (see docs/testing.md):
//  - unit: lib/* against a test database, embeddings mocked. Fast, deterministic.
//  - api:  the real server over HTTP (auth cookies, CSRF, access control).
//          No LM Studio required.
//  - ai:   model-dependent — real embeddings for retrieval ranking, real chat
//          turns with loose assertions. Opt-in via `npm run test:ai`; suites
//          skip themselves when LM Studio is down.
//
// Each project gets its own database so they can run concurrently; files
// within a project run sequentially because they share one database and
// truncate it between tests.
const project = (name: "unit" | "api" | "ai", overrides: Record<string, unknown> = {}) => ({
  test: {
    name,
    include: [`test/${name}/**/*.test.ts`],
    env: { DATABASE_URL: dbUrl(name) },
    globalSetup: [`./test/global/${name}.ts`],
    fileParallelism: false,
    hookTimeout: 60_000,
    ...overrides,
  },
});

export default defineConfig({
  test: {
    projects: [
      project("unit", { testTimeout: 15_000 }),
      project("api", { testTimeout: 20_000 }),
      project("ai", { testTimeout: 180_000 }),
    ],
  },
});
