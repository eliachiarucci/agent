import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UIMessage } from "ai";

import { writeConversationFileBytes } from "../../lib/agent/files";
import {
  buildImageFileParts,
  imagePartUrl,
  inlineImageFileParts,
} from "../../lib/agent/image-parts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-image-parts-"));
  process.env.FILES_DIR = root;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const conversationId = () => crypto.randomUUID();

describe("buildImageFileParts", () => {
  it("builds file parts pointing at the upload's download URL", () => {
    const id = conversationId();
    expect(buildImageFileParts(id, ["photo.png", "pic.jpg"])).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        filename: "photo.png",
        url: imagePartUrl(id, "photo.png"),
      },
      {
        type: "file",
        mediaType: "image/jpeg",
        filename: "pic.jpg",
        url: imagePartUrl(id, "pic.jpg"),
      },
    ]);
    expect(imagePartUrl(id, "photo.png")).toBe(
      `/agent/files/download?conversation_id=${id}&name=photo.png&source=upload`
    );
  });
});

describe("inlineImageFileParts", () => {
  it("swaps stored URLs for data URLs of the upload's bytes", async () => {
    const id = conversationId();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeConversationFileBytes(id, "photo.png", bytes, 1024, "upload");

    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "look at this" },
          ...buildImageFileParts(id, ["photo.png"]),
        ],
      },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "nice" }] },
    ];

    const inlined = await inlineImageFileParts(messages, id);
    expect(inlined[0].parts[0]).toEqual({ type: "text", text: "look at this" });
    expect(inlined[0].parts[1]).toMatchObject({
      type: "file",
      mediaType: "image/png",
      url: `data:image/png;base64,${bytes.toString("base64")}`,
    });
    // Untouched messages (and the stored history) keep their original parts.
    expect(inlined[1]).toBe(messages[1]);
    expect(messages[0].parts[1]).toMatchObject({ url: imagePartUrl(id, "photo.png") });
  });

  it("degrades a missing upload to a text note instead of a dead URL", async () => {
    const id = conversationId();
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: buildImageFileParts(id, ["gone.png"]) },
    ];

    const inlined = await inlineImageFileParts(messages, id);
    expect(inlined[0].parts).toEqual([
      { type: "text", text: '[Attached image "gone.png" is no longer available]' },
    ]);
  });
});
