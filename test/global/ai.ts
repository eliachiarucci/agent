import { ensureTestDatabase } from "../setup/database";
import { startTestServer } from "../setup/server";
import { dbUrl, SERVER_PORTS, TEST_DBS } from "../config";

let stopServer: (() => void) | undefined;

export async function setup() {
  await ensureTestDatabase(TEST_DBS.ai);
  // The server starts even when LM Studio is down; individual suites probe
  // LM Studio and skip themselves so `npm run test:ai` never hard-fails on it.
  stopServer = await startTestServer({ port: SERVER_PORTS.ai, databaseUrl: dbUrl("ai") });
}

export async function teardown() {
  stopServer?.();
}
