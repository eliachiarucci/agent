import express from "express";
import { connectorCredentialHandlers } from "../connectors";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "POST, PATCH, DELETE, OPTIONS");
  res.sendStatus(204);
};

export const { POST, PATCH, DELETE } = connectorCredentialHandlers("google-calendar");
