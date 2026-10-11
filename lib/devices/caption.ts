import { generateText, NoObjectGeneratedError, Output, type LanguageModelUsage } from "ai";
import { z } from "zod";
import type { PerceptionTarget } from "./perception-model";

// The perception call (plan 4.4): one camera frame plus the previous caption in,
// a structured caption out. Shared with scripts/vision-bench.ts, which measured
// it across models in P0.

export const captionSchema = z.object({
  summary: z.string().describe("One or two sentences about the scene"),
  changes: z
    .string()
    .describe('What changed since the previous description; "none" if nothing relevant changed'),
  entities: z.array(
    z.object({
      kind: z.enum(["person", "animal", "vehicle", "object"]),
      description: z.string(),
      isNew: z.boolean(),
    })
  ),
  salience: z.number().min(0).max(1),
  wake: z.enum(["none", "log", "agent"]),
  reason: z.string(),
});
export type Caption = z.infer<typeof captionSchema>;

// The vision model never identifies anyone (plan D17): names come only from the
// face module, as text.
export const PERCEPTION_INSTRUCTIONS = `You are the eyes of a small rover in a private garden. Each message brings one camera frame (a wide, lens-corrected view from close to the ground) and the description of the previous frame.

Describe what you see and what changed:
- summary: one or two sentences about the scene.
- changes: what changed since the previous description; "none" if nothing relevant changed, "first frame" if there is no previous description.
- entities: the people, animals, vehicles and notable objects in view, each with a short visual description, and isNew = true if it wasn't in the previous description.
- salience: 0 for nothing of interest (an empty garden, a change in light), up to 1 for something that needs attention now.
- wake: "none" if nothing relevant changed; "log" for a change worth a line in the day's log; "agent" when the rover's agent should decide whether to act (someone arrives or speaks to the rover, an animal is in the garden, something unusual or possibly unsafe).
- reason: one short sentence on why you chose that wake level.

Never say who a person is, even if you think you recognise them: describe people only by what is visible (clothes, posture, what they are doing). Names, when known, come from a separate face-recognition step.
Describe only what is in the frame; don't guess at what is outside it.`;

export type CaptionResult =
  | { ok: true; caption: Caption; usage: LanguageModelUsage; responseId?: string }
  | { ok: false; error: string; usage?: LanguageModelUsage; rawText?: string };

export async function captionFrame(params: {
  target: PerceptionTarget;
  image: Uint8Array;
  previous: Caption | null;
  timeoutMs?: number;
}): Promise<CaptionResult> {
  const { target, image, previous } = params;
  try {
    const result = await generateText({
      model: target.model,
      system: PERCEPTION_INSTRUCTIONS,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: previous
                ? `Previous description:\n${JSON.stringify(previous)}`
                : "No previous description: this is the first frame.",
            },
            { type: "image", image, mediaType: "image/jpeg" },
          ],
        },
      ],
      output: Output.object({ schema: captionSchema }),
      providerOptions: target.providerOptions,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(params.timeoutMs ?? 60_000),
    });
    return { ok: true, caption: result.output, usage: result.usage, responseId: result.response.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (NoObjectGeneratedError.isInstance(error)) {
      return { ok: false, error: message, usage: error.usage, rawText: error.text };
    }
    return { ok: false, error: message };
  }
}
