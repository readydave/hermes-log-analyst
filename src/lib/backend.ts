import type { CrashRecord, NormalizedEvent, SupportedOs } from "../types/events";
import type { ThemeMode } from "../types/events";
import type { ExportFormat } from "../types/events";

export interface IngestProfile {
  autoSyncOnStartup: boolean;
  maxEventsPerSync: number;
  windowsChannels: string[];
}

export interface SyncOperationResult {
  collected: number;
  warnings: string[];
}

export interface LlmProviderSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmSettings {
  preferredProvider: string;
  allowLanDiscovery: boolean;
  neverSendRawEventToUntrusted: boolean;
  trustedHosts: string[];
  ollama: LlmProviderSettings;
  lmstudio: LlmProviderSettings;
  openai: LlmProviderSettings;
  gemini: LlmProviderSettings;
  claude: LlmProviderSettings;
  perplexity: LlmProviderSettings;
  openaiCompatible: LlmProviderSettings;
}

export interface LlmEndpointCandidate {
  providerId: string;
  endpoint: string;
  scope: "localhost" | "lan" | string;
  host: string;
  port: number;
}

function createDefaultLlmProviderSettings(baseUrl = "", enabled = false): LlmProviderSettings {
  return {
    enabled,
    baseUrl,
    apiKey: "",
    model: ""
  };
}

function createDefaultLlmSettings(): LlmSettings {
  return {
    preferredProvider: "ollama",
    allowLanDiscovery: false,
    neverSendRawEventToUntrusted: true,
    trustedHosts: [],
    ollama: createDefaultLlmProviderSettings("http://127.0.0.1:11434", true),
    lmstudio: createDefaultLlmProviderSettings("http://127.0.0.1:1234", false),
    openai: createDefaultLlmProviderSettings("https://api.openai.com/v1", false),
    gemini: createDefaultLlmProviderSettings("https://generativelanguage.googleapis.com/v1beta", false),
    claude: createDefaultLlmProviderSettings("https://api.anthropic.com/v1", false),
    perplexity: createDefaultLlmProviderSettings("https://api.perplexity.ai", false),
    openaiCompatible: createDefaultLlmProviderSettings("", false)
  };
}

function detectBrowserOs(): SupportedOs {
  if (navigator.userAgent.includes("Windows")) return "windows";
  if (navigator.userAgent.includes("Mac")) return "macos";
  return "linux";
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export async function getHostOs(): Promise<SupportedOs> {
  if (!isTauriRuntime()) return detectBrowserOs();

  const { invoke } = await import("@tauri-apps/api/core");
  const value = await invoke<string>("host_os");
  if (value === "windows" || value === "linux" || value === "macos") return value;
  return detectBrowserOs();
}

export async function getHostOsVersion(): Promise<string> {
  if (!isTauriRuntime()) return "Unknown (browser mode)";

  const { invoke } = await import("@tauri-apps/api/core");
  const value = await invoke<string>("host_os_version");
  return value?.trim() ? value.trim() : "Unknown (not provided by host)";
}

export async function getIngestWindowDays(): Promise<number> {
  if (!isTauriRuntime()) return 7;

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("get_ingest_window_days");
}

export async function getIngestProfile(): Promise<IngestProfile> {
  if (!isTauriRuntime()) {
    return {
      autoSyncOnStartup: false,
      maxEventsPerSync: 2000,
      windowsChannels: ["Application", "System", "Security"]
    };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<IngestProfile>("get_ingest_profile");
}

export async function setIngestProfile(profile: IngestProfile): Promise<IngestProfile> {
  if (!isTauriRuntime()) return profile;

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<IngestProfile>("set_ingest_profile", { profile });
}

export async function setIngestWindowDays(days: number): Promise<number> {
  if (!isTauriRuntime()) return days;

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("set_ingest_window_days", { days });
}

export async function getLlmSettings(): Promise<LlmSettings> {
  if (!isTauriRuntime()) return createDefaultLlmSettings();

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmSettings>("get_llm_settings");
}

export async function setLlmSettings(settings: LlmSettings): Promise<LlmSettings> {
  if (!isTauriRuntime()) return settings;

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmSettings>("set_llm_settings", { settings });
}

export async function detectLocalLlmProviders(): Promise<LlmEndpointCandidate[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmEndpointCandidate[]>("detect_local_llm_providers");
}

export async function scanLanLlmProviders(maxHosts = 256): Promise<LlmEndpointCandidate[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmEndpointCandidate[]>("scan_lan_llm_providers", { maxHosts });
}

export async function backfillLocalEvents(from: string, to: string): Promise<SyncOperationResult> {
  if (!isTauriRuntime()) return { collected: 0, warnings: [] };

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SyncOperationResult>("backfill_local_events", { from, to });
}

export async function syncLocalEventsRange(
  from: string,
  to: string,
  replaceOutsideRange = false
): Promise<SyncOperationResult> {
  if (!isTauriRuntime()) return { collected: 0, warnings: [] };

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SyncOperationResult>("sync_local_events_range", { from, to, replaceOutsideRange });
}

export async function refreshLocalEvents(): Promise<SyncOperationResult> {
  if (!isTauriRuntime()) return { collected: 0, warnings: [] };

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SyncOperationResult>("refresh_local_events");
}

export async function getLocalEvents(limit = 10000): Promise<NormalizedEvent[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NormalizedEvent[]>("get_local_events", { limit });
}

export async function getLocalEventsRange(
  from: string,
  to: string,
  limit = 20000
): Promise<NormalizedEvent[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NormalizedEvent[]>("get_local_events_range", { from, to, limit });
}

export async function importHostCrashes(limit = 200): Promise<number> {
  if (!isTauriRuntime()) return 0;

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("import_host_crashes", { limit });
}

export async function getCrashes(limit = 250): Promise<CrashRecord[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CrashRecord[]>("get_crashes", { limit });
}

export async function getCrashRelatedEvents(
  crashId: string,
  windowMinutes = 15,
  limit = 200
): Promise<NormalizedEvent[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NormalizedEvent[]>("get_crash_related_events", {
    crashId,
    windowMinutes,
    limit
  });
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("Only http/https URLs are allowed.");
  }

  if (!isTauriRuntime()) {
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) throw new Error("Browser blocked opening the URL.");
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_external_url", { url });
}

export async function getExportDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) return null;

  const { invoke } = await import("@tauri-apps/api/core");
  const value = await invoke<string | null>("get_export_directory");
  return value?.trim() ? value.trim() : null;
}

export async function chooseExportDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) return null;

  const { invoke } = await import("@tauri-apps/api/core");
  const value = await invoke<string | null>("choose_export_directory");
  return value?.trim() ? value.trim() : null;
}

export async function setExportDirectory(path: string | null): Promise<void> {
  if (!isTauriRuntime()) return;

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_export_directory", { path });
}

export async function exportEventsToFile(
  format: ExportFormat,
  filename: string,
  events: NormalizedEvent[]
): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("File export path settings require desktop runtime.");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("export_events", { format, filename, events });
}

export async function exportEventsWithDialog(
  format: ExportFormat,
  suggestedFilename: string,
  events: NormalizedEvent[]
): Promise<string | null> {
  if (!isTauriRuntime()) return null;

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("export_events_with_dialog", {
    format,
    suggestedFilename,
    events
  });
}

export async function quitApp(): Promise<void> {
  if (!isTauriRuntime()) {
    window.close();
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("quit_app");
}

export async function setAppTheme(theme: ThemeMode): Promise<void> {
  if (!isTauriRuntime()) return;

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_app_theme", { theme });
}

export async function getSavedTheme(): Promise<ThemeMode | null> {
  if (!isTauriRuntime()) return null;

  const { invoke } = await import("@tauri-apps/api/core");
  const theme = await invoke<string | null>("get_saved_theme");
  if (theme === "system" || theme === "light" || theme === "dark") return theme;
  return null;
}
