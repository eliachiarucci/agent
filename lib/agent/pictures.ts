import type { ModelMessage } from "ai";

// Pictures a device's agent takes (takePicture, zoom). The model sees each one
// as an image in a user message right after the tool's result. A tool can't
// return the image itself: OpenAI-compatible providers (OpenRouter) serialise
// tool results to JSON text, so the model would get base64 instead of a picture.
//
// During the call that takes them, TakenPictures holds them and prepareStep
// re-inserts them on every step (the SDK hands each step the messages without
// earlier overrides). Afterwards the conversation keeps only the tool's result,
// which names the picture's file in the conversation's uploads;
// insertStoredPictures puts the images back on every later call, so the agent
// can look at them again. They aren't windowed like camera frames: they're few,
// asked for, and never change, so the prompt prefix stays cacheable.

export const PICTURE_TOOLS = ["takePicture", "zoom"] as const;

export type TakenPicture = { image: Uint8Array; label: string };

function pictureMessage(picture: TakenPicture): ModelMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: `[${picture.label}]` },
      { type: "image", image: picture.image, mediaType: "image/jpeg" },
    ],
  };
}

type PictureOutput = { file?: unknown; label?: unknown; taken?: unknown };

/**
 * The messages with the picture of every earlier takePicture / zoom result put
 * back after it, read from the conversation's uploads by `load` (null when the
 * file is gone: the result's text stays alone).
 */
export async function insertStoredPictures(
  messages: ModelMessage[],
  load: (file: string) => Promise<Uint8Array | null>
): Promise<ModelMessage[]> {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    out.push(message);
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || !(PICTURE_TOOLS as readonly string[]).includes(part.toolName)) continue;
      const value = (part.output.type === "json" ? part.output.value : null) as PictureOutput | null;
      if (typeof value?.file !== "string") continue;
      const image = await load(value.file);
      if (!image) continue;
      const label =
        typeof value.label === "string"
          ? value.label
          : `picture from the camera${typeof value.taken === "string" ? `, ${value.taken}` : ""}`;
      out.push(pictureMessage({ image, label }));
    }
  }
  return out;
}

export class TakenPictures {
  private readonly byCall = new Map<string, TakenPicture>();

  add(toolCallId: string, picture: TakenPicture): void {
    this.byCall.set(toolCallId, picture);
  }

  get size(): number {
    return this.byCall.size;
  }

  /** The messages with each picture after the tool message that holds its result. */
  insert(messages: ModelMessage[]): ModelMessage[] {
    if (this.byCall.size === 0) return messages;
    const out: ModelMessage[] = [];
    for (const message of messages) {
      out.push(message);
      if (message.role !== "tool") continue;
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const picture = this.byCall.get(part.toolCallId);
        if (picture) out.push(pictureMessage(picture));
      }
    }
    return out;
  }

  /** For streamText / generateText's prepareStep. */
  readonly prepareStep = ({ messages }: { messages: ModelMessage[] }) =>
    this.byCall.size > 0 ? { messages: this.insert(messages) } : {};
}
