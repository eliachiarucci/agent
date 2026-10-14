import { describe, expect, it } from "vitest";
import { buildDeviceTools, deviceSystemPrompt } from "../../lib/agent/device-run";
import { TakenPictures } from "../../lib/agent/pictures";
import { DEFAULT_DEVICE_SETTINGS, mergeDeviceSettings } from "../../lib/devices/settings";
import type { Device } from "../../lib/db/devices";

const device = { id: "00000000-0000-7000-8000-000000000001", name: "Dino" } as Device;

function tools(disabled: string[]) {
  const settings = mergeDeviceSettings(DEFAULT_DEVICE_SETTINGS, { tools: { disabled: disabled as any } });
  return Object.keys(
    buildDeviceTools({
      device,
      settings,
      deps: {} as any,
      memoryScope: null,
      conversationId: "c",
      timeZone: "UTC",
      agentId: "a",
      ownerId: "o",
      pictures: new TakenPictures(),
    })
  );
}

const prompt = (disabledTools: any[]) =>
  deviceSystemPrompt({ basePrompt: "", agentPrompt: null, memorySystemPrompt: "", deviceName: "Dino", description: null, disabledTools });

describe("device tools", () => {
  it("leaves out the tools switched off, and the rules don't mention them", () => {
    expect(tools([])).toEqual(
      expect.arrayContaining(["speak", "zoom", "takePicture", "searchObservations", "listNotes", "webSearch", "readPage"])
    );
    const some = tools(["speak", "takePicture"]);
    expect(some).not.toContain("speak");
    expect(some).not.toContain("takePicture");
    expect(some).toEqual(expect.arrayContaining(["zoom", "searchObservations", "listNotes"]));

    expect(prompt([])).toContain("call takePicture first");
    expect(prompt([])).toContain("the speak tool");
    const off = prompt(["speak", "takePicture", "zoom", "searchObservations"]);
    expect(off).not.toMatch(/takePicture|zoom|searchObservations|speak \(the speak tool\)/);
    expect(off).toContain("can't take pictures");
    expect(off).toContain("the speak tool is off");
  });
});
