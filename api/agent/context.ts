import express from 'express';
import { getContextWindow } from "../../lib/agent/context";

export const config = {}

export const GET: express.RequestHandler = async (_req, res) => {
    res.json(await getContextWindow());
}
