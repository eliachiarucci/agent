import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captionFrame, type Caption } from "../../lib/devices/caption";
import { buildPerceptionModel, perceptionProviderOptions } from "../../lib/devices/perception-model";
import { PROVIDER_TYPES, type ProviderType } from "../../lib/global/schema";
import { LMSTUDIO_URL, lmStudioUp } from "../config";

// The perception call against a real vision model and real rover frames.
// The frames aren't in the repo (they're the user's own captures): point
// VISION_FRAMES at a folder of lens-corrected JPEGs, e.g. the P0 bench frames.
//
//   VISION_FRAMES=../rover2/radxa_software/captures/bench-20261011/frames VISION_MATCH=2576x1449 npm run test:ai
//
// The model is LM Studio's VISION_MODEL (default google/gemma-4-e4b) unless
// VISION_PROVIDER names another provider, with its key in VISION_API_KEY and,
// for OpenRouter, an optional endpoint pin in VISION_ROUTE (e.g.
// google-vertex/europe). Skips when there are no frames or no model.
const FRAMES = process.env.VISION_FRAMES;
const MATCH = process.env.VISION_MATCH ?? "";
const PROVIDER = (process.env.VISION_PROVIDER ?? "lmstudio") as ProviderType;
const MODEL = process.env.VISION_MODEL ?? "google/gemma-4-e4b";
const API_KEY = process.env.VISION_API_KEY;
const ROUTE = process.env.VISION_ROUTE;

const modelReady =
  PROVIDER_TYPES.includes(PROVIDER) && (PROVIDER === "lmstudio" ? await lmStudioUp() : !!API_KEY);

describe.skipIf(!FRAMES || !modelReady)("perception on real frames", () => {
  it("returns a caption that fits the schema for every frame, chained", async () => {
    const names = (await readdir(FRAMES!)).filter((n) => /\.jpe?g$/i.test(n) && n.includes(MATCH)).sort();
    expect(names.length).toBeGreaterThan(0);

    // An OpenRouter endpoint pin is part of the model id ("model@endpoint").
    const modelId = ROUTE ? `${MODEL}@${ROUTE}` : MODEL;
    const target = {
      provider: PROVIDER,
      modelId,
      model: buildPerceptionModel(PROVIDER, { url: LMSTUDIO_URL, apiKey: API_KEY }, modelId),
      providerOptions: perceptionProviderOptions(PROVIDER, modelId),
    };

    let previous: Caption | null = null;
    const captions: Caption[] = [];
    for (const name of names) {
      const result = await captionFrame({ target, image: await readFile(join(FRAMES!, name)), previous });
      if (!result.ok) throw new Error(`${name}: ${result.error}`);
      // Reasoning stays off (P0: 0 reasoning tokens with these options).
      expect(result.usage.outputTokenDetails?.reasoningTokens ?? 0).toBe(0);
      expect(result.caption.summary.length).toBeGreaterThan(10);
      captions.push(result.caption);
      previous = result.caption;
    }
    // The first frame has nothing to compare with.
    expect(captions[0].changes.toLowerCase()).toMatch(/first|none|n\/a/);
  });
});
