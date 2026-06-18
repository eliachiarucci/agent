import { chatModelFromSettings, defaultChatModel } from "../global/ai";
import { getProviderSetting } from "../db/provider-settings";
import { getUserSettings } from "../db/user-settings";
import type { ProviderSettingsValue, ProviderType } from "../global/schema";

export type DefaultModelTarget = {
  provider: ProviderType;
  settings: ProviderSettingsValue;
  model: string;
};

// The user's configured default model as provider + settings + modelId, or null
// to mean "use the env default". null when unset or the provider was removed.
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

// The user's default chat model, or the env-configured model when none is set.
export async function resolveDefaultChatModel(userId: string) {
  const target = await resolveDefaultModelTarget(userId);
  return target
    ? chatModelFromSettings(target.provider, target.settings, target.model)
    : defaultChatModel();
}
