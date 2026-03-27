import type { CrashRecord, NormalizedEvent } from "../types/events";

const REDACTION = "<sensitive info redacted>";

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]{1,4}\b/gi,
  /\b(?:S-\d-\d+-(?:\d+-){1,}\d+)\b/gi,
  /https?:\/\/[^\s]+/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi,
  /\\\\[A-Za-z0-9_.-]+\\[^\s]+/g,
  /\b[A-Za-z]:\\(?:[^\\\r\n\t ]+\\)*[^\\\r\n\t ]*/g,
  /(?:^|[\s(])\/(?:[^\s/]+\/)+[^\s/]+/g,
  /\b[A-Za-z0-9_.-]+\\[A-Za-z0-9_.-]+\b/g,
  /\b(?:user(?:name)?|account|device|host(?:name)?|computer(?:name)?|machine(?:name)?)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
  /\b(?:token|apikey|api_key|secret|password|passwd|sessionid|auth)\s*[:=]\s*[^\s,;]+/gi,
  /\b[A-Za-z0-9_-]{24,}\b/g
];

export function redactSensitiveText(input: string): string {
  let output = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    output = output.replace(pattern, (match) => {
      if (match.startsWith(" /")) {
        return ` ${REDACTION}`;
      }
      if (match.startsWith("(")) {
        return `(${REDACTION}`;
      }
      return REDACTION;
    });
  }
  return output;
}

function getOsVersionHint(event: NormalizedEvent, hostOsVersion?: string, redact = true): string {
  const protect = (value: string) => (redact ? redactSensitiveText(value) : value);
  if (hostOsVersion && hostOsVersion.trim()) {
    return protect(hostOsVersion.trim());
  }

  const raw = event.raw as Record<string, unknown> | undefined;
  const value = raw?.osVersion ?? raw?.os_version ?? raw?.version;
  return typeof value === "string" && value.trim() ? protect(value) : "Unknown (not provided by event source)";
}

function osLabel(event: NormalizedEvent, hostOsVersion?: string, redact = true): string {
  const protect = (value: string) => (redact ? redactSensitiveText(value) : value);
  const version = getOsVersionHint(event, hostOsVersion, redact).toLowerCase();
  if (event.os === "windows") {
    if (version.includes("11")) return "Windows 11";
    if (version.includes("10")) return "Windows 10";
    return "Windows";
  }
  if (event.os === "linux") return "Linux";
  if (event.os === "macos") return "macOS";
  return protect(event.os);
}

function categoryLabel(event: NormalizedEvent, redact = true): string {
  const protect = (value: string) => (redact ? redactSensitiveText(value) : value);
  const logName = protect(event.logName);
  const category = protect(event.category);
  return `${logName} / ${category}`;
}

function analystRolePrompt(event: NormalizedEvent, hostOsVersion?: string, redact = true): string {
  const os = osLabel(event, hostOsVersion, redact);
  const focus = categoryLabel(event, redact);
  return `Act as an expert in ${os} ${focus} log analysis for incident triage and remediation.`;
}

export function buildLlmPrompt(event: NormalizedEvent, hostOsVersion?: string, redact = true): string {
  const protect = (value: string) => (redact ? redactSensitiveText(value) : value);
  const osName = osLabel(event, hostOsVersion, redact);
  const osVersion = getOsVersionHint(event, hostOsVersion, redact);
  const timestamp = protect(event.timestamp);
  const logName = protect(event.logName);
  const category = protect(event.category);
  const provider = protect(event.provider);
  const severity = protect(event.severity);
  const message = protect(event.message);

  return [
    analystRolePrompt(event, hostOsVersion, redact),
    `You are a senior incident response and reliability engineer specializing in ${osName} (version: ${osVersion}).`,
    "Analyze the event below and provide concise, practical triage guidance for a sysadmin/helpdesk team.",
    "Return FINAL answer only.",
    "Do not include internal reasoning, self-talk, scratchpad notes, rule restatements, or chain-of-thought.",
    "Keep response concise (target <= 220 words).",
    "",
    "Rules:",
    "1) Treat any sensitive values as private.",
    `2) If redacted placeholders are present, keep exactly "${REDACTION}" as-is.`,
    "3) Prefer safe, read-only verification steps first.",
    "4) If you recommend commands, place each command in fenced code blocks for copy/paste.",
    "5) Avoid destructive actions unless clearly marked optional and high-risk.",
    "6) If external lookup is needed, state what to check briefly; do not fabricate citations.",
    "7) If this could indicate a security threat, clearly flag it and prioritize containment actions.",
    "",
    "Event Context:",
    `OS: ${osName}`,
    `OS Version: ${osVersion}`,
    `Timestamp: ${timestamp}`,
    `Log: ${logName}`,
    `Category: ${category}`,
    `Provider: ${provider}`,
    `Event ID: ${event.eventId ?? "N/A"}`,
    `Severity: ${severity}`,
    `Message: ${message}`,
    "",
    "Return output in this exact Markdown template:",
    "## Summary",
    "- <1-2 line summary>",
    "## Likely Causes",
    "- <cause 1>",
    "- <cause 2>",
    "- <cause 3>",
    "## Risk Level",
    "- <Low|Medium|High|Critical> - <one-line reason>",
    "## Security Impact",
    "- <impact or 'None observed'>",
    "## Verify First",
    "- <safe read-only check 1>",
    "- <safe read-only check 2>",
    "## Remediation Options",
    "- <safest action>",
    "- <next action>",
    "- <strongest action if needed>",
    "## Escalate If",
    "- <criteria 1>",
    "- <criteria 2>",
    "## Confidence",
    "- <0-100%>",
    "## Missing Data",
    "- <missing item 1>",
    "- <missing item 2>"
  ].join("\n");
}

export function buildGoogleQuery(event: NormalizedEvent): string {
  const tokens = [
    redactSensitiveText(event.os),
    redactSensitiveText(event.logName),
    `event id ${event.eventId ?? ""}`,
    redactSensitiveText(event.provider),
    redactSensitiveText(event.message.slice(0, 120))
  ];

  return encodeURIComponent(tokens.join(" ").trim());
}

export interface CrashRcaSessionMetric {
  label: string;
  count: number;
}

export interface CrashRcaPromptInput {
  crash: CrashRecord;
  hostOsVersion?: string;
  minidumpSummary: string;
  minidumpDetails: string[];
  likelyCause: string;
  verifyFirst: string[];
  escalateIf: string[];
  preCrashEvents: NormalizedEvent[];
  correlatedEvents: NormalizedEvent[];
  sessionCoverage: string;
  severityMetrics: CrashRcaSessionMetric[];
  providerMetrics: CrashRcaSessionMetric[];
  logTypeMetrics: CrashRcaSessionMetric[];
  noisySourceMetrics: CrashRcaSessionMetric[];
  relevantExcerpts: string[];
  contextReadinessNote?: string;
}

function severityWeight(severity: NormalizedEvent["severity"]): number {
  switch (severity) {
    case "critical":
      return 4;
    case "error":
      return 3;
    case "warning":
      return 2;
    default:
      return 1;
  }
}

function truncateText(value: string, max = 140): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function formatCrashIndicatorLine(event: NormalizedEvent, redact = true): string {
  const protect = (value: string) => (redact ? redactSensitiveText(value) : value);
  const eventIdPart = typeof event.eventId === "number" ? `Event ID ${event.eventId}` : "Event ID N/A";
  return [
    protect(new Date(event.timestamp).toLocaleString()),
    protect(event.provider),
    eventIdPart,
    protect(event.severity),
    protect(truncateText(event.message))
  ].join(" | ");
}

function isCrashConfirmationContextEvent(event: NormalizedEvent): boolean {
  const provider = event.provider.toLowerCase();
  const message = event.message.toLowerCase();
  return (
    (provider.includes("kernel-power") && event.eventId === 41) ||
    (provider.includes("volmgr") && (event.eventId === 161 || event.eventId === 162)) ||
    event.eventId === 1001 ||
    provider.includes("bugcheck") ||
    message.includes("rebooted without cleanly shutting down") ||
    message.includes("system has rebooted without cleanly shutting down") ||
    message.includes("dump file creation succeeded")
  );
}

function buildCrashIndicatorLines(
  primaryEvents: NormalizedEvent[],
  fallbackEvents: NormalizedEvent[],
  redact = true
): string[] {
  const source = primaryEvents.length > 0 ? primaryEvents : fallbackEvents;
  return [...source]
    .filter((event) => !isCrashConfirmationContextEvent(event))
    .sort((a, b) => {
      const severityDelta = severityWeight(b.severity) - severityWeight(a.severity);
      if (severityDelta !== 0) return severityDelta;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    })
    .slice(0, 4)
    .map((event) => `- ${formatCrashIndicatorLine(event, redact)}`);
}

function buildTopCrashEventIdLines(events: NormalizedEvent[], redact = true): string[] {
  const protect = (value: string) => (redact ? redactSensitiveText(value) : value);
  const counts = new Map<number, number>();
  for (const event of events) {
    if (typeof event.eventId === "number") {
      counts.set(event.eventId, (counts.get(event.eventId) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 6)
    .map(([eventId, count]) => `- ${protect(String(eventId))}: ${count}`);
}

export function buildCrashRcaPrompt(input: CrashRcaPromptInput, redact = true): string {
  const protect = (value: string) => (redact ? redactSensitiveText(value) : value);
  const osLabelValue =
    input.crash.os === "windows" ? "Windows" : input.crash.os === "macos" ? "macOS" : "Linux";
  const dumpLabel =
    input.crash.os === "linux"
      ? "Core Dump"
      : input.crash.source.toLowerCase() === "kerneldump"
        ? "Kernel Dump"
        : "Minidump";
  const primaryCrashCodeLabel = input.crash.os === "windows" ? "bugcheck code" : input.crash.os === "linux" ? "signal" : "crash code";
  const platformLogViewer = input.crash.os === "windows" ? "Event Viewer" : "the platform log viewer";
  const platformLogName = input.crash.os === "windows" ? "Event Viewer/System logs" : "platform system logs";
  const platformMissingCodeGuidance =
    input.crash.os === "windows"
      ? "For missing bugcheck code, prefer Windows WER/BugCheck events (such as System Event ID 1001) or direct dump analysis. Do not use Kernel-Power Event ID 41 as the primary bugcheck source."
      : input.crash.os === "linux"
        ? "For missing signal or crash code, prefer `journalctl` near the crash time and `coredumpctl info` before broader speculation."
        : "For missing crash code, prefer platform-native crash logs and dump metadata before broader speculation.";
  const platformDebuggerGuidance =
    input.crash.os === "windows"
      ? "In How To Get Missing Data, prefer WinDbg as the primary tool for authoritative dump analysis. BlueScreenView may be mentioned only as a lightweight quick-look tool."
      : input.crash.os === "linux"
        ? "In How To Get Missing Data, prefer `coredumpctl info` and `coredumpctl gdb` as the primary tools for authoritative core-dump analysis."
        : "In How To Get Missing Data, prefer platform-native debugger-backed dump analysis rather than speculative remediation.";
  const platformEscalationGuidance =
    input.crash.os === "windows"
      ? "In Escalate If, include broader criteria such as WinDbg or WER/Event ID 1001 pointing outside the current hypothesis, repeated crashes after version/update verification, or symbol-backed analysis implicating a different driver path."
      : input.crash.os === "linux"
        ? "In Escalate If, include broader criteria such as repeated crashes after package/library verification or debugger-backed core-dump analysis implicating a different binary/library path."
        : "In Escalate If, include broader criteria such as repeated crashes after version verification or debugger-backed dump analysis implicating a different component.";
  const hermesIndicatorLines = buildCrashIndicatorLines(input.preCrashEvents, input.correlatedEvents, redact);
  const topEventIdLines = buildTopCrashEventIdLines(input.correlatedEvents, redact);
  const summaryLines = [
    `Crash summary: ${protect(input.crash.summary)}`,
    `Crash type: ${protect(input.crash.crashType)}`,
    `Crash source: ${protect(input.crash.source)}`,
    `Crash timestamp: ${protect(input.crash.timestamp)}`,
    `Source host: ${protect(input.crash.sourceHost)}`,
    `Crash code: ${protect(input.crash.code ?? "Unavailable")}`,
    `Suspected component: ${protect(input.crash.suspectedComponent ?? "Unknown")}`
  ];

  const metricLines = (label: string, metrics: CrashRcaSessionMetric[]) => [
    `${label}:`,
    ...(metrics.length > 0
      ? metrics.map((metric) => `- ${protect(metric.label)}: ${metric.count}`)
      : ["- None loaded"])
  ];

  const excerptLines =
    input.relevantExcerpts.length > 0
      ? input.relevantExcerpts.map((entry) => `- ${protect(entry)}`)
      : ["- No raw event excerpts were selected."];

  const verifyLines =
    input.verifyFirst.length > 0
      ? input.verifyFirst.map((entry) => `- ${protect(entry)}`)
      : ["- No verification guidance prepared."];

  const escalateLines =
    input.escalateIf.length > 0
      ? input.escalateIf.map((entry) => `- ${protect(entry)}`)
      : ["- Escalate if crash evidence remains inconclusive."];

  return [
    `Act as a senior ${osLabelValue} crash triage and root-cause analysis specialist.`,
    `You are assisting support with a selected ${osLabelValue} crash using a parsed dump summary and the currently loaded host session.`,
    "Return FINAL answer only.",
    "Do not include chain-of-thought, self-talk, or internal reasoning.",
    "Keep the response concise, concrete, and support-oriented.",
    "",
    "Rules:",
    "1) Treat all host-identifying values as private.",
    `2) Preserve "${REDACTION}" placeholders exactly if present.`,
    "3) Prefer evidence-backed reasoning over speculation.",
    "4) Distinguish clearly between observed evidence, inference, and missing data.",
    "5) Suggest safe read-only checks before changes.",
    "6) If evidence is weak, say so directly.",
    "7) Do not recommend uninstalling, deleting, or removing kernel drivers, system files, or core Windows components.",
    "8) If a high-risk action might eventually be needed, label it high-risk and escalation-only, not as a first-line support step.",
    "9) Every section in the template below must be filled. Do not leave sections blank or say only 'Not provided'.",
    `10) If Hermes already has pre-crash or correlated evidence loaded, do not tell the operator to re-check the same logs in ${platformLogViewer}.`,
    "11) When Hermes already has pre-crash indicators loaded, the first Verify First bullet must begin exactly with 'Hermes found these pre-crash indicators:' and summarize the strongest loaded indicators.",
    `12) Only tell the operator to check ${platformLogName} when Hermes does not currently have the required crash evidence loaded.`,
    "13) Treat reboot/crash-confirmation events as crash context, not as pre-crash cause evidence.",
    "14) Treat dump-generation events and dump-file creation success as crash context, not as pre-crash cause evidence.",
    "15) Do not list dump-file availability as a pre-crash indicator.",
    `16) If the ${primaryCrashCodeLabel} or stack trace is missing, describe the RCA as a working hypothesis and keep confidence moderate rather than high.`,
    "17) Prefer evidence preservation and targeted verification before recommending a reboot or broader disruptive actions.",
    `18) ${platformMissingCodeGuidance}`,
    "19) Output exactly one risk level: Low, Medium, High, or Critical. Never return combined labels like 'Medium - High'.",
    "20) Avoid broad environment changes like 'clean boot with Hyper-V disabled' unless clearly labeled as controlled isolation testing after evidence preservation.",
    "21) In Verify First, prefer version, package/signer provenance, and recent update/install history checks for the suspected driver or module over redundant dump-readability checks if Hermes already analyzed the dump.",
    ...(input.crash.os === "windows"
      ? ["22) If nearby WUDFRd/PnP warnings are present, describe them as adjacent driver-load instability that may be related, not as direct proof that WUDFRd caused the crash."]
      : []),
    `23) ${platformDebuggerGuidance}`,
    `24) ${platformEscalationGuidance}`,
    "",
    "Crash Packet:",
    ...summaryLines,
    `Host OS version: ${protect(input.hostOsVersion ?? "Unknown")}`,
    `Loaded session coverage: ${protect(input.sessionCoverage)}`,
    `Pre-crash loaded events: ${input.preCrashEvents.length}`,
    `Correlated events (+/-15m): ${input.correlatedEvents.length}`,
    input.contextReadinessNote ? `Context note: ${protect(input.contextReadinessNote)}` : "",
    "",
    `${dumpLabel} Triage Summary:`,
    `- ${protect(input.minidumpSummary)}`,
    ...input.minidumpDetails.map((entry) => `- ${protect(entry)}`),
    `Likely cause note: ${protect(input.likelyCause)}`,
    "",
    ...metricLines("Severity distribution", input.severityMetrics),
    ...metricLines("Top providers", input.providerMetrics),
    ...metricLines("Top log types", input.logTypeMetrics),
    ...metricLines("Noisy sources", input.noisySourceMetrics),
    "Top correlated Event IDs:",
    ...(topEventIdLines.length > 0 ? topEventIdLines : ["- None loaded"]),
    "",
    "Hermes pre-crash indicators:",
    ...(hermesIndicatorLines.length > 0
      ? hermesIndicatorLines
      : ["- No pre-crash indicators are currently loaded in Hermes. If bugcheck or power-loss evidence is needed, tell the operator to load a wider Hermes System log window first."]),
    "",
    "Relevant raw excerpts:",
    ...excerptLines,
    "",
    "Prepared verification items:",
    ...verifyLines,
    "",
    "Prepared escalation items:",
    ...escalateLines,
    "",
    "Return output in this exact Markdown template:",
    "## Summary",
    "- <1-2 line root-cause summary with the likely cause clearly stated>",
    "## Likely Causes",
    "- Most likely RCA: <single best-supported cause hypothesis>",
    "- Supporting evidence: <top evidence from dump/logs>",
    "- Remaining uncertainty: <what is still not proven>",
    "## Risk Level",
    "- <Low|Medium|High|Critical> - <one-line operational rationale>",
    "## Security Impact",
    "- <state direct security impact, or say 'No direct security impact confirmed from available crash evidence.'>",
    "## Verify First",
    "- <read-only check 1>",
    "- <read-only check 2>",
    "## Remediation Options",
    "- <safest operator action>",
    "- <next recommended action>",
    "- <optional high-risk action only if clearly labeled escalation-only>",
    "## Escalate If",
    "- <criteria 1>",
    "- <criteria 2>",
    "## Confidence",
    "- <0-100%>",
    "- Why: <1-2 short sentences explaining why the confidence is at that level based on observed evidence vs. missing data>",
    "## Missing Data",
    "- <missing item 1>",
    "- <missing item 2>",
    "## How To Get Missing Data",
    input.crash.os === "windows"
      ? "- <operator-friendly step to retrieve bugcheck code if missing>"
      : input.crash.os === "linux"
        ? "- <operator-friendly step to retrieve the signal or crash code if missing>"
        : "- <operator-friendly step to retrieve the primary crash code if missing>",
    input.crash.os === "linux"
      ? "- <operator-friendly step to retrieve a backtrace or module context, including debugger/symbol note when applicable>"
      : "- <operator-friendly step to retrieve stack trace if missing, including debugger/symbol note when applicable>"
  ]
    .filter((line) => line !== "")
    .join("\n");
}
