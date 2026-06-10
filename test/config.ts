// Shared constants for the test setup. Imported by vitest.config.ts, the
// global setups, and the helpers — keep it dependency-free.

export const PG_BASE = "postgres://postgres:postgres@localhost:5432";

// One database per project so unit/api/ai suites can run in parallel without
// trampling each other's truncations.
export const TEST_DBS = {
  unit: "agent_test_unit",
  api: "agent_test_api",
  ai: "agent_test_ai",
} as const;

export type TestProject = keyof typeof TEST_DBS;

export const dbUrl = (project: TestProject) => `${PG_BASE}/${TEST_DBS[project]}`;

// Off the dev port (3001) so test servers and `npm run dev` coexist.
export const SERVER_PORTS = { api: 3101, ai: 3102 } as const;
export const serverUrl = (project: keyof typeof SERVER_PORTS) =>
  `http://localhost:${SERVER_PORTS[project]}`;

export const TEST_AUTH_SECRET = "vitest-only-secret-not-for-production";
export const TEST_APP_ORIGIN = "http://localhost:5173";

export const LMSTUDIO_URL = process.env.LMSTUDIO_URL ?? "http://localhost:1234";

/** True when LM Studio answers; AI-tier suites skip (not fail) otherwise. */
export async function lmStudioUp(): Promise<boolean> {
  try {
    const res = await fetch(`${LMSTUDIO_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
