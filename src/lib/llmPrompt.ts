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
