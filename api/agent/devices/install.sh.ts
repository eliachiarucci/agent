import express from 'express';
import { deviceInstallScript } from "../../../lib/devices/install-script";

export const config = {}

export const OPTIONS: express.RequestHandler = async (req, res) => {
    res.set('Allow', 'GET, OPTIONS');
    res.sendStatus(204);
}

// The device install script (lib/devices/install-script.ts), public: it holds
// nothing but this server's address; the pairing code is the credential.
export const GET: express.RequestHandler = async (req, res) => {
    const origin = process.env.APP_ORIGIN ?? "http://localhost:5173";
    res.set("Cache-Control", "no-store");
    res.type("text/plain; charset=utf-8").send(deviceInstallScript(origin));
}
