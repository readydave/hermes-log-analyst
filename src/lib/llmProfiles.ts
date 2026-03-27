import type { LlmConnectionProfile } from "./backend";

const compatibleProviders = new Set([
  "ollama",
  "lmstudio",
  "openai_compatible",
  "openai",
  "gemini",
  "claude",
  "perplexity"
]);

export function isCompatibleLlmProvider(provider: string): boolean {
  return compatibleProviders.has(provider.trim().toLowerCase());
}

export function isRunnableLlmProfile(profile: LlmConnectionProfile): boolean {
  return profile.enabled && isCompatibleLlmProvider(profile.provider);
}

export function pickDefaultRunnableLlmProfileId(
  profiles: LlmConnectionProfile[],
  defaultProfileId: string
): string {
  const runnable = profiles.filter(isRunnableLlmProfile);
  return (
    runnable.find((profile) => profile.id === defaultProfileId)?.id ??
    runnable[0]?.id ??
    ""
  );
}

export function llmProfileValidationSignature(profile: LlmConnectionProfile): string {
  return [
    profile.id,
    profile.provider.trim().toLowerCase(),
    profile.scope.trim().toLowerCase(),
    profile.baseUrl.trim(),
    profile.model.trim(),
    profile.enabled ? "enabled" : "disabled",
    profile.apiKeyConfigured ? "key" : "no-key"
  ].join("|");
}
