import type { NormalizedEvent } from "../types/events";

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

function getOsVersionHint(event: NormalizedEvent, hostOsVersion?: string): string {
  if (hostOsVersion && hostOsVersion.trim()) {
    return redactSensitiveText(hostOsVersion.trim());
  }

  const raw = event.raw as Record<string, unknown> | undefined;
  const value = raw?.osVersion ?? raw?.os_version ?? raw?.version;
  return typeof value === "string" && value.trim() ? redactSensitiveText(value) : "Unknown (not provided by event source)";
}

function osLabel(event: NormalizedEvent, hostOsVersion?: string): string {
  const version = getOsVersionHint(event, hostOsVersion).toLowerCase();
  if (event.os === "windows") {
    if (version.includes("11")) return "Windows 11";
    if (version.includes("10")) return "Windows 10";
    return "Windows";
  }
  if (event.os === "linux") return "Linux";
  if (event.os === "macos") return "macOS";
  return redactSensitiveText(event.os);
}

function categoryLabel(event: NormalizedEvent): string {
  const logName = redactSensitiveText(event.logName);
  const category = redactSensitiveText(event.category);
  return `${logName} / ${category}`;
}

function analystRolePrompt(event: NormalizedEvent, hostOsVersion?: string): string {
  const os = osLabel(event, hostOsVersion);
  const focus = categoryLabel(event);
  return `Act as an expert in ${os} ${focus} log analysis for incident triage and remediation.`;
}

export function buildLlmPrompt(event: NormalizedEvent, hostOsVersion?: string): string {
  const osName = osLabel(event, hostOsVersion);
  const osVersion = getOsVersionHint(event, hostOsVersion);
  const timestamp = redactSensitiveText(event.timestamp);
  const logName = redactSensitiveText(event.logName);
  const category = redactSensitiveText(event.category);
  const provider = redactSensitiveText(event.provider);
  const severity = redactSensitiveText(event.severity);
  const message = redactSensitiveText(event.message);

  return [
    analystRolePrompt(event, hostOsVersion),
    `You are a senior incident response and reliability engineer specializing in ${osName} (version: ${osVersion}).`,
    "Analyze the event below and provide concise, practical triage guidance for a sysadmin team.",
    "",
    "Rules:",
    "1) Treat any sensitive values as private and keep redacted placeholders as-is.",
    `2) If sensitive content is present, use exactly "${REDACTION}" in your response.`,
    "3) Prefer safe, read-only verification steps first.",
    "4) If you recommend commands, place each command in fenced code blocks for copy/paste.",
    "5) Avoid destructive actions unless clearly marked optional and high-risk.",
    "6) Search online for similar reported issues and include likely matches with short rationale.",
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
    "Return output in this exact structure:",
    "1) Summary (1-2 lines)",
    "2) Likely Causes (top 3, ranked)",
    "3) Risk Level (Low/Medium/High/Critical + why)",
    "4) Security Impact (state 'None observed' if not applicable)",
    "5) Verify First (safe checks)",
    "6) Remediation Options (ordered safest to strongest)",
    "7) Escalate If (clear criteria)",
    "8) Confidence (0-100%) and Missing Data"
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
