import express from "express";
import { getSessionUser } from "../../lib/agent/actor";
import { MEMORY_SYSTEM_PROMPT } from "../../lib/agent/memory";
import { MEMORY_EXTRACTION_SYSTEM_PROMPT } from "../../lib/agent/memory-extraction";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, OPTIONS");
  res.sendStatus(204);
};

// The built-in memory prompts — the chat model's memory instructions and the
// background extractor's system prompt — so the UI's Settings → Memories
// editors can offer them as starting points for custom prompts
// (agents.chat_memory_prompt / memory_extraction_prompt) without duplicating
// the text.
export const GET: express.RequestHandler = async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json({ chat: MEMORY_SYSTEM_PROMPT, extraction: MEMORY_EXTRACTION_SYSTEM_PROMPT });
};
