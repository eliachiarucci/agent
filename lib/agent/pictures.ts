import type { ModelMessage } from "ai";

// Pictures a device's agent took during one model call (the takePicture tool).
// The model sees each one as an image in a user message right after the tool's
// result. A tool can't return the image itself: OpenAI-compatible providers
// (OpenRouter) serialise tool results to JSON text, so the model would get
// base64 instead of a picture. prepareStep re-inserts them on every step, since
// the SDK hands each step the messages without earlier overrides.

export type TakenPicture = { image: Uint8Array; label: string };

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
        if (!picture) continue;
        out.push({
          role: "user",
          content: [
            { type: "text", text: `[${picture.label}]` },
            { type: "image", image: picture.image, mediaType: "image/jpeg" },
          ],
        });
      }
    }
    return out;
  }

  /** For streamText / generateText's prepareStep. */
  readonly prepareStep = ({ messages }: { messages: ModelMessage[] }) =>
    this.byCall.size > 0 ? { messages: this.insert(messages) } : {};
}
