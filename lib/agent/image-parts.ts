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
