import type { FileUIPart, UIMessage } from "ai";
import { imageMediaTypeFor, readConversationFileBytes } from "./files";

// Image attachments live on the user message as standard AI SDK file parts.
// The stored part's url is the app's own download route (the UI renders it
// directly with the session cookie), which no model provider could fetch — so
// right before the model call the parts are swapped for data: URLs read from
// the conversation's uploads folder. The base64 payload is deterministic, so
// the prompt prefix stays byte-stable across turns (KV-cache reuse).

/** The download URL stored on an image file part (and rendered by the UI). */
export function imagePartUrl(conversationId: string, name: string): string {
  return `/agent/files/download?conversation_id=${encodeURIComponent(
    conversationId
  )}&name=${encodeURIComponent(name)}&source=upload`;
}

export function buildImageFileParts(conversationId: string, names: string[]): FileUIPart[] {
  return names.map((name) => ({
    type: "file",
    mediaType: imageMediaTypeFor(name) ?? "application/octet-stream",
    filename: name,
    url: imagePartUrl(conversationId, name),
  }));
}

/**
 * Model-view transform: replace each image file part's app URL with a data URL
 * of the upload's bytes. A missing file (e.g. deleted upload) degrades to a
 * text note so the message never carries a URL the provider can't resolve.
 */
export async function inlineImageFileParts(
  messages: UIMessage[],
  conversationId: string
): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (message.role !== "user" || !message.parts.some((p) => p.type === "file")) {
        return message;
      }
      const parts = await Promise.all(
        message.parts.map(async (part) => {
          if (part.type !== "file" || !part.filename) return part;
          const bytes = await readConversationFileBytes(conversationId, part.filename, "upload");
          if (!bytes) {
            return {
              type: "text" as const,
              text: `[Attached image "${part.filename}" is no longer available]`,
            };
          }
          return { ...part, url: `data:${part.mediaType};base64,${bytes.toString("base64")}` };
        })
      );
      return { ...message, parts };
    })
  );
}

// What a user message's metadata may say about its images: a short text
// stand-in per file name, e.g. "frame 15:02: a fox crosses the lawn".
export type ImageLabelsMetadata = { imageLabels?: Record<string, string> };

/**
 * Model-view transform for long image-heavy logs (a device's daily log):
 * images in user messages older than the last `keep` messages that carry any
 * are replaced by their text label. A message's replacement depends only on
 * its own metadata, so once an image leaves the window the prompt prefix up
 * to it stays byte-identical (prompt caching keeps working).
 */
export function windowImageParts(messages: UIMessage[], keep = 2): UIMessage[] {
  const withImages = messages.flatMap((m, i) =>
    m.role === "user" && m.parts.some((p) => p.type === "file") ? [i] : []
  );
  const outside = new Set(withImages.slice(0, Math.max(0, withImages.length - keep)));
  return messages.map((message, i) => {
    if (!outside.has(i)) return message;
    const labels = (message.metadata as ImageLabelsMetadata | undefined)?.imageLabels ?? {};
    return {
      ...message,
      parts: message.parts.map((part) =>
        part.type === "file"
          ? {
              type: "text" as const,
              text: `[${(part.filename && labels[part.filename]) || `image ${part.filename ?? ""}`.trim()}]`,
            }
          : part
      ),
    };
  });
}
