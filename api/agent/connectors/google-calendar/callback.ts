import express from "express";
import { connectorCallbackHandler } from "../../connectors";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, OPTIONS");
  res.sendStatus(204);
};

export const GET = connectorCallbackHandler("google-calendar");
