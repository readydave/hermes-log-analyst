import type { CrashRecord, NormalizedEvent, SupportedOs } from "../types/events";
import type { ThemeMode } from "../types/events";
import type { ExportFormat } from "../types/events";

export interface IngestProfile {
  autoSyncOnStartup: boolean;
  maxEventsPerSync: number;
  windowsChannels: string[];
  requestElevation: boolean;
}

export interface SyncOperationResult {
  collected: number;
  warnings: string[];
}

export interface EventLoadEstimate {
  windowStart: string;
  windowEnd: string;
  estimatedCount: number;
  estimatedBytes: number;
  warnings: string[];
}

export interface RemoteConnectionProfile {
  id: string;
  name: string;
  host: string;
  os: string;
  protocol: string;
  username: string;
  sshKeyPath: string | null;
  authType: string;
  secretConfigured?: boolean;
  providerDeviceId?: string | null;
  providerLastResolvedName?: string | null;
  providerLastResolvedAt?: string | null;
}

export interface RemoteProviderAccount {
  id: string;
  provider: "jamf" | "intune" | string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  tenantId: string;
  apiTokenConfigured: boolean;
}

export interface RemoteConnectionTestResult {
  ok: boolean;
  protocol: string;
  host: string;
  status: string;
  message: string;
  warnings: string[];
  collectionMode: "direct" | "managed" | "async-managed" | "unsupported";
  providerDeviceId: string | null;
  providerResolvedName: string | null;
  providerLastResolvedAt: string | null;
}

export interface RemoteSettings {
  profiles: RemoteConnectionProfile[];
  providerAccounts: RemoteProviderAccount[];
}

function createDefaultRemoteSettings(): RemoteSettings {
  return {
    profiles: [],
    providerAccounts: [
      {
        id: "provider-jamf",
        provider: "jamf",
        name: "Jamf Pro",
        enabled: false,
        baseUrl: "",
        tenantId: "",
        apiTokenConfigured: false
      },
      {
        id: "provider-intune",
        provider: "intune",
        name: "Microsoft Intune",
        enabled: false,
        baseUrl: "https://graph.microsoft.com",
        tenantId: "",
        apiTokenConfigured: false
      }
    ]
  };
}

export async function getRemoteSettings(): Promise<RemoteSettings> {
  if (!isTauriRuntime()) return createDefaultRemoteSettings();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<RemoteSettings>("get_remote_settings");
}

export async function saveRemoteSettings(settings: RemoteSettings): Promise<RemoteSettings> {
  if (!isTauriRuntime()) return settings;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<RemoteSettings>("save_remote_settings", { settings });
}

export async function saveRemoteProfileSecret(profileId: string, secret: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_remote_profile_secret", { profileId, secret });
}

export async function clearRemoteProfileSecret(profileId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("clear_remote_profile_secret", { profileId });
}

export async function saveRemoteProviderSecret(providerId: string, secret: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_remote_provider_secret", { providerId, secret });
}

export async function clearRemoteProviderSecret(providerId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("clear_remote_provider_secret", { providerId });
}

export async function testRemoteConnection(
  profile: RemoteConnectionProfile
): Promise<RemoteConnectionTestResult> {
  if (!isTauriRuntime()) {
    return {
      ok: false,
      protocol: profile.protocol,
      host: profile.host,
      status: "unsupported",
      message: "Remote connection tests require desktop runtime.",
      warnings: [],
      collectionMode: "unsupported",
      providerDeviceId: null,
      providerResolvedName: null,
      providerLastResolvedAt: null
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<RemoteConnectionTestResult>("test_remote_connection", { profile });
}

export interface LlmConnectionProfile {
  id: string;
  name: string;
  provider: string;
  scope: "local" | "lan" | "cloud" | "generic" | string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  apiKeyConfigured: boolean;
}

export interface LlmSettings {
  allowLanDiscovery: boolean;
  neverSendRawEventToUntrusted: boolean;
  trustedHosts: string[];
  profiles: LlmConnectionProfile[];
  defaultProfileId: string;
  backupProfileId: string;
  preferredLanInterfaceId: string;
}

export interface LlmEndpointCandidate {
  providerId: string;
  endpoint: string;
  scope: "localhost" | "lan" | string;
  host: string;
  port: number;
  interfaceId: string;
  interfaceName: string;
  networkCidr: string;
}

export interface LlmNetworkInterface {
  id: string;
  name: string;
  ip: string;
  cidr: string;
  isPrivate: boolean;
  isLoopback: boolean;
  isLinkLocal: boolean;
  isDefaultCandidate: boolean;
}

export interface LlmConnectionTestResult {
  ok: boolean;
  provider: string;
  baseUrl: string;
  statusCode: number | null;
  message: string;
  detectedModels: string[];
  preferredModel: string | null;
}

export interface LlmAnalysisResult {
  ok: boolean;
  profileId: string;
  profileName: string;
  provider: string;
  baseUrl: string;
  model: string;
  response: string;
  fallbackUsed: boolean;
  warning: string | null;
}

export interface MinidumpAnalysisResult {
  ok: boolean;
  crashId: string;
  crashType: string;
  source: string;
  dumpPath: string | null;
  dumpExists: boolean;
  dumpKind: string;
  dumpSizeBytes: number | null;
  dumpModifiedAt: string | null;
  headerSignature: string | null;
  headerVersion: string | null;
  headerStreamCount: number | null;
  headerTimestamp: string | null;
  bugcheckCode: string | null;
  bugcheckParameters: string[];
  suspectedModule: string | null;
  likelyCauseCategory: string;
  confidence: number;
  summary: string;
  crashDetails: string[];
  likelyCause: string;
  verifyFirst: string[];
  escalateIf: string[];
  warnings: string[];
  unavailableReason: string | null;
}

function createDefaultLlmProfile(): LlmConnectionProfile {
  return {
    id: "profile-ollama-local",
    name: "Ollama Local",
    provider: "ollama",
    scope: "local",
    baseUrl: "http://127.0.0.1:11434",
    model: "",
    enabled: true,
    apiKeyConfigured: false
  };
}

function createDefaultLlmSettings(): LlmSettings {
  return {
    allowLanDiscovery: false,
    neverSendRawEventToUntrusted: true,
    trustedHosts: [],
    profiles: [createDefaultLlmProfile()],
    defaultProfileId: "profile-ollama-local",
    backupProfileId: "",
    preferredLanInterfaceId: ""
  };
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

export async function setLlmProfileApiKey(profileId: string, apiKey: string): Promise<LlmSettings> {
  if (!isTauriRuntime()) return createDefaultLlmSettings();

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmSettings>("set_llm_profile_api_key", { profileId, apiKey });
}

export async function clearLlmProfileApiKey(profileId: string): Promise<LlmSettings> {
  if (!isTauriRuntime()) return createDefaultLlmSettings();

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmSettings>("clear_llm_profile_api_key", { profileId });
}

export async function detectLocalLlmProviders(): Promise<LlmEndpointCandidate[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmEndpointCandidate[]>("detect_local_llm_providers");
}

export async function listLlmNetworkInterfaces(
  includeNonPrivate = false,
  includeLoopback = false
): Promise<LlmNetworkInterface[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmNetworkInterface[]>("list_llm_network_interfaces", {
    includeNonPrivate,
    includeLoopback
  });
}

export async function scanLanLlmProviders(
  interfaceId?: string,
  maxHosts = 256
): Promise<LlmEndpointCandidate[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmEndpointCandidate[]>("scan_lan_llm_providers", { interfaceId, maxHosts });
}

export async function testLlmProfileConnection(
  profile: LlmConnectionProfile
): Promise<LlmConnectionTestResult> {
  if (!isTauriRuntime()) {
    return {
      ok: false,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      statusCode: null,
      message: "Connection test requires desktop runtime.",
      detectedModels: [],
      preferredModel: null
    };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmConnectionTestResult>("test_llm_profile_connection", { profile });
}

export async function analyzeWithLocalLlm(
  prompt: string,
  profileId?: string
): Promise<LlmAnalysisResult> {
  if (!isTauriRuntime()) {
    throw new Error("Local LLM analysis requires desktop runtime.");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LlmAnalysisResult>("analyze_with_local_llm", { prompt, profileId });
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

export async function estimateRefreshLocalEvents(): Promise<EventLoadEstimate> {
  if (!isTauriRuntime()) {
    return {
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      estimatedCount: 0,
      estimatedBytes: 0,
      warnings: []
    };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<EventLoadEstimate>("estimate_refresh_local_events");
}

export async function estimateLocalEventsRange(from: string, to: string): Promise<EventLoadEstimate> {
  if (!isTauriRuntime()) {
    return {
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      estimatedCount: 0,
      estimatedBytes: 0,
      warnings: []
    };
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<EventLoadEstimate>("estimate_local_events_range", { from, to });
}

export async function refreshLocalEvents(targetId?: string): Promise<SyncOperationResult> {
  if (!isTauriRuntime()) return { collected: 0, warnings: [] };

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SyncOperationResult>("refresh_local_events", { targetId });
}

export async function getLocalEvents(targetId?: string, limit = 10000): Promise<NormalizedEvent[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NormalizedEvent[]>("get_local_events", { targetId, limit });
}

export async function getLocalEventsRange(
  targetId: string | undefined,
  from: string,
  to: string,
  limit = 20000
): Promise<NormalizedEvent[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NormalizedEvent[]>("get_local_events_range", { targetId, from, to, limit });
}

export async function importHostCrashes(targetId?: string, limit = 200): Promise<number> {
  if (!isTauriRuntime()) return 0;

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("import_host_crashes", { targetId, limit });
}

export async function getCrashes(targetId?: string, limit = 250): Promise<CrashRecord[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CrashRecord[]>("get_crashes", { targetId, limit });
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

export async function analyzeMinidump(
  crashId: string,
  windowMinutes = 15
): Promise<MinidumpAnalysisResult> {
  if (!isTauriRuntime()) {
    throw new Error("Minidump analysis requires desktop runtime.");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<MinidumpAnalysisResult>("analyze_minidump", {
    crashId,
    windowMinutes
  });
}

export async function syncLocalEventsWindow(
  start: string,
  end: string,
  targetId?: string
): Promise<SyncOperationResult> {
  if (!isTauriRuntime()) return { collected: 0, warnings: [] };

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SyncOperationResult>("sync_local_events_window", { targetId, start, end });
}

export async function getLocalEventsWindow(
  start: string,
  end: string,
  limit = 10000,
  targetId?: string
): Promise<NormalizedEvent[]> {
  if (!isTauriRuntime()) return [];

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NormalizedEvent[]>("get_local_events_window", { targetId, start, end, limit });
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

export async function openPathInShell(path: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Opening local paths requires desktop runtime.");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_path_in_shell", { path });
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

export async function saveTextWithDialog(
  suggestedFilename: string,
  text: string
): Promise<string | null> {
  if (!isTauriRuntime()) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedFilename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return suggestedFilename;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("save_text_with_dialog", {
    suggestedFilename,
    text
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

export async function restartElevated(): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Elevated restart is only available in desktop runtime.");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_elevated");
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


export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getHostOs(): Promise<SupportedOs> {
  if (!isTauriRuntime()) return "windows";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SupportedOs>("host_os");
}

export async function getHostOsVersion(): Promise<string> {
  if (!isTauriRuntime()) return "Unknown";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("host_os_version");
}

export async function getIngestProfile(): Promise<IngestProfile> {
  if (!isTauriRuntime()) return { autoSyncOnStartup: false, maxEventsPerSync: 1000, windowsChannels: ["Application", "System", "Security"], requestElevation: false };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<IngestProfile>("get_ingest_profile");
}

export async function getIngestWindowDays(): Promise<number> {
  if (!isTauriRuntime()) return 7;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("get_ingest_window_days");
}
