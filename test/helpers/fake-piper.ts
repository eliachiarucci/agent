import { createServer, type Server } from "node:http";

// A stand-in for the Piper container (POST /synthesize → WAV), on the port the
// test server's PIPER_URL points at (test/config.ts fakePiperPort).

/** A 16-bit mono PCM WAV of `ms` milliseconds of silence. */
export function silentWav(ms: number, sampleRate = 22050): Buffer {
  const dataBytes = Math.round((sampleRate * ms) / 1000) * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

export async function startFakePiper(port: number) {
  const requests: Array<{ text: string; voice?: string }> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/synthesize") {
        res.statusCode = 404;
        res.end();
        return;
      }
      requests.push(JSON.parse(body));
      res.setHeader("content-type", "audio/wav");
      res.end(silentWav(800));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
