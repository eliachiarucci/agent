import { chatModelFromSettings } from "../global/ai";
import { getProviderSetting } from "../db/provider-settings";
import { getUserSettings } from "../db/user-settings";
import type { ProviderSettingsValue, ProviderType } from "../global/schema";

export type DefaultModelTarget = {
  provider: ProviderType;
  settings: ProviderSettingsValue;
  model: string;
};

// The user's configured default model as provider + settings + modelId, or null
// when no default is set (or its provider was removed). There is no fallback —
// a model must be picked in Settings → Models.
export async function resolveDefaultModelTarget(
  userId: string
): Promise<DefaultModelTarget | null> {
  const settings = await getUserSettings(userId);
  if (!settings?.defaultProvider) return null;
  const setting = await getProviderSetting(userId, settings.defaultProvider);
  const modelId = settings.defaultModel ?? setting?.settings.model;
  if (!setting || !modelId) return null;
  return { provider: settings.defaultProvider, settings: setting.settings, model: modelId };
}

// The user's default chat model, or null when none is configured. There is no
// hardcoded fallback: a model must be picked in Settings → Models.
export async function resolveDefaultChatModel(userId: string) {
  const target = await resolveDefaultModelTarget(userId);
  return target ? chatModelFromSettings(target.provider, target.settings, target.model) : null;
}

// Both the model and the target that produced it (both null when no default is
// configured). The target is what context-window lookups and auto-compaction
// need; building it alongside the model avoids resolving the settings twice.
export async function resolveDefaultChatModelAndTarget(userId: string) {
  const target = await resolveDefaultModelTarget(userId);
  const model = target
    ? chatModelFromSettings(target.provider, target.settings, target.model)
    : null;
  return { model, target };
}
