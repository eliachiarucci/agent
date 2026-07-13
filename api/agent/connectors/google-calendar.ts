import express from "express";
import { connectorCredentialHandlers } from "../connectors";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "POST, DELETE, OPTIONS");
  res.sendStatus(204);
};

export const { POST, DELETE } = connectorCredentialHandlers("google-calendar");
