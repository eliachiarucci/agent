import { spawnSync } from "node:child_process";
import pg from "pg";
import { PG_BASE } from "../config";

// Creates the test database if missing, enables pgvector, and syncs the schema
// with drizzle-kit push. Idempotent: reruns are no-ops when already in sync.
export async function ensureTestDatabase(dbName: string): Promise<void> {
  const admin = new pg.Client({ connectionString: `${PG_BASE}/postgres` });
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
    if (exists.rowCount === 0) await admin.query(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }

  const db = new pg.Client({ connectionString: `${PG_BASE}/${dbName}` });
  await db.connect();
  try {
    await db.query("create extension if not exists vector");
  } finally {
    await db.end();
  }

  const push = spawnSync("npx", ["drizzle-kit", "push", "--force"], {
    env: { ...process.env, DATABASE_URL: `${PG_BASE}/${dbName}` },
    encoding: "utf8",
  });
  if (push.status !== 0) {
    throw new Error(`drizzle-kit push failed for ${dbName}:\n${push.stdout}\n${push.stderr}`);
  }
}
