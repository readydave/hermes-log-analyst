import { describe, expect, it } from "vitest";

import type { LlmConnectionProfile } from "./backend";
import {
  isRunnableLlmProfile,
  llmProfileValidationSignature,
  pickDefaultRunnableLlmProfileId
} from "./llmProfiles";

function createProfile(overrides: Partial<LlmConnectionProfile> = {}): LlmConnectionProfile {
  return {
    id: "profile-1",
    name: "Profile 1",
    provider: "ollama",
    scope: "local",
    baseUrl: "http://127.0.0.1:11434",
    model: "",
    enabled: true,
    apiKeyConfigured: false,
    ...overrides
  };
}

describe("llmProfiles", () => {
  it("uses the saved default when it is enabled and compatible", () => {
    const profiles = [
      createProfile({ id: "cloud-openai", provider: "openai", scope: "cloud" }),
      createProfile({ id: "local-ollama", provider: "ollama", scope: "local" })
    ];

    expect(pickDefaultRunnableLlmProfileId(profiles, "cloud-openai")).toBe("cloud-openai");
  });

  it("falls back to the first enabled compatible profile", () => {
    const profiles = [
      createProfile({ id: "disabled-default", enabled: false }),
      createProfile({ id: "unsupported", provider: "custom-provider" }),
      createProfile({ id: "local-ollama", provider: "ollama", scope: "local" })
    ];

    expect(isRunnableLlmProfile(profiles[0])).toBe(false);
    expect(isRunnableLlmProfile(profiles[1])).toBe(false);
    expect(pickDefaultRunnableLlmProfileId(profiles, "disabled-default")).toBe("local-ollama");
  });

  it("changes validation signature when runtime-relevant fields change", () => {
    const base = createProfile({ id: "profile-1", model: "gpt-4.1-mini" });
    const changedUrl = createProfile({
      id: "profile-1",
      model: "gpt-4.1-mini",
      baseUrl: "https://api.example.com/v1"
    });
    const changedModel = createProfile({ id: "profile-1", model: "gpt-4.1" });

    expect(llmProfileValidationSignature(base)).not.toBe(llmProfileValidationSignature(changedUrl));
    expect(llmProfileValidationSignature(base)).not.toBe(llmProfileValidationSignature(changedModel));
  });
});
