import express from "express";
import { connectorAuthorizeHandler } from "../../connectors";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, OPTIONS");
  res.sendStatus(204);
};

export const GET = connectorAuthorizeHandler("google-calendar");
