import { spawn } from "node:child_process";
import express from "express";
import { getSessionUser } from "../../lib/agent/actor";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, OPTIONS");
  res.sendStatus(204);
};

// Streams a pg_dump of the whole database as a download. Custom format (-Fc)
// is compressed and restored with pg_restore; the migrations journal is part
// of the dump, so restoring an old backup into a newer release just leaves
// migrate() to apply the missing migrations at startup (docs/install.md).
//
// The dump spans every user on the server (accounts, provider credentials,
// connector tokens) — any authenticated member can take one, which matches
// the home-server trust model where the operator creates all accounts.
// Conversation files live on disk under FILES_DIR and are not included.
export const GET: express.RequestHandler = async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    res.status(500).json({ error: "DATABASE_URL is not configured" });
    return;
  }

  const child = spawn("pg_dump", ["--format=custom", databaseUrl], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  // pg_dump missing entirely (dev machines without postgres client tools).
  child.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "pg_dump is not available on the server" });
    } else {
      res.destroy();
    }
  });

  // Headers are only sent once pg_dump produces output, so early failures
  // (version mismatch, bad credentials) still get a JSON error instead of an
  // empty "successful" download.
  child.stdout.once("data", (first: Buffer) => {
    if (res.destroyed) return;
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="agent-backup-${date}.dump"`);
    res.write(first);
    child.stdout.pipe(res, { end: false });
  });

  child.on("close", (code) => {
    if (code === 0 && res.headersSent) {
      res.end();
      return;
    }
    const error = `pg_dump failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
    if (!res.headersSent) {
      res.status(500).json({ error });
    } else {
      // Mid-stream failure: cut the connection so the browser reports a
      // failed download rather than saving a truncated dump as complete.
      console.error(error);
      res.destroy();
    }
  });

  // Client gave up (closed tab, aborted download): stop dumping.
  res.on("close", () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
};
