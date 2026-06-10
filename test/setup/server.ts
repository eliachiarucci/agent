import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import * as esbuild from "esbuild";
import { apiRoutesPlugin } from "../../plugins/api-routes.ts";
import { TEST_APP_ORIGIN, TEST_AUTH_SECRET, testFilesDir } from "../config";

// Builds the real server (same esbuild pipeline as dev/prod, including the
// virtual api-routes module) and runs it as a child process against the test
// database. Going over real HTTP is the point: it exercises Better Auth's
// cookie handling, the auth handler mounted before express.json(), and SSE.
export async function startTestServer(options: {
  port: number;
  databaseUrl: string;
}): Promise<() => void> {
  // A stale server on this port would answer the health check below and every
  // test request — with whatever code/env it was started with. Refuse to run.
  const occupied = await fetch(`http://localhost:${options.port}/`, {
    signal: AbortSignal.timeout(1000),
  }).then(() => true, () => false);
  if (occupied) {
    throw new Error(
      `Port ${options.port} is already in use (stale test server?). ` +
        `Free it with: lsof -ti :${options.port} | xargs kill`
    );
  }

  const outfile = `dist/test-server-${options.port}.js`;
  await esbuild.build({
    entryPoints: ["index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    packages: "external",
    plugins: [apiRoutesPlugin],
    logLevel: "silent",
  });

  // index.ts loads dotenv, but dotenv never overrides variables that are
  // already set — these take precedence over .env.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(options.port),
    DATABASE_URL: options.databaseUrl,
    BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
    APP_ORIGIN: TEST_APP_ORIGIN,
    // Better Auth's isTest() (NODE_ENV=test or TEST=true) disables its
    // origin/CSRF protections — which would silently neuter the security
    // tests. The server under test must behave like the real deployment,
    // except for the per-IP rate limiter (every request comes from 127.0.0.1).
    NODE_ENV: "production",
    AUTH_RATE_LIMIT: "off",
    // Public signup is disabled in production (users are created via the CLI),
    // but test fixtures are built through real sign-ups over HTTP.
    AUTH_SIGNUP: "on",
    // Conversation files go under dist/ (wiped here for a clean slate); tests
    // reach the same folder via testFilesDir(port).
    FILES_DIR: testFilesDir(options.port),
  };
  rmSync(testFilesDir(options.port), { recursive: true, force: true });
  // Vitest exports these into its own environment; they must not leak in.
  delete env.TEST;
  delete env.VITEST;

  const child = spawn("node", [outfile], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited with code ${child.exitCode}:\n${output}`);
    }
    try {
      const res = await fetch(`http://localhost:${options.port}/`);
      // Re-check liveness after the fetch: a child that just died of
      // EADDRINUSE means someone else answered the health check.
      if (res.ok && child.exitCode === null) return () => child.kill();
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill();
  throw new Error(`Test server did not start within 20s:\n${output}`);
}
