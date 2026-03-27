import type { CrashRecord, SupportedOs } from "../types/events";

export type LlmAnalysisContextKind = "event" | "crash-rca";

export interface LlmAnalysisGuide {
  summary: string;
  likelyCauses: string[];
  riskLevel: string;
  securityImpact: string;
  verifyFirst: string[];
  remediationOptions: string[];
  escalateIf: string[];
  confidence: string;
  missingData: string[];
  howToGetMissingData: string[];
  cleanedRaw: string;
}

export function isDumpBackedCrash(crash: CrashRecord | null): boolean {
  if (!crash) return false;
  const source = crash.source.toLowerCase();
  const crashType = crash.crashType.toLowerCase();
  return (
    (crash.os === "windows" && (source === "minidump" || source === "kerneldump")) ||
    (crash.os === "linux" && (source === "coredump" || crashType === "core dump"))
  );
}

export function crashDumpLabel(crash: CrashRecord | null): string {
  if (!crash) return "Dump";
  const source = crash.source.toLowerCase();
  const crashType = crash.crashType.toLowerCase();
  if (crash.os === "linux" && (source === "coredump" || crashType === "core dump")) {
    return "Core Dump";
  }
  if (source === "kerneldump") {
    return "Kernel Dump";
  }
  return "Minidump";
}

export function crashAnalysisTitle(crash: CrashRecord | null): string {
  return `${crashDumpLabel(crash)} Analysis`;
}

function crashEvidenceGapLabel(crashOs: SupportedOs): string {
  return crashOs === "windows"
    ? "bugcheck code or deeper dump evidence"
    : crashOs === "linux"
      ? "signal, backtrace, or deeper core-dump evidence"
      : "crash code or deeper dump evidence";
}

const llmGuideSectionMatchers: Array<{
  key:
    | "summary"
    | "likelyCauses"
    | "riskLevel"
    | "securityImpact"
    | "verifyFirst"
    | "remediationOptions"
    | "escalateIf"
    | "confidence"
    | "missingData"
    | "howToGetMissingData";
  regex: RegExp;
}> = [
  { key: "summary", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?summary\b[:\-]*/i },
  { key: "likelyCauses", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?(?:likely causes?|most likely rca)\b[:\-]*/i },
  { key: "riskLevel", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?risk level\b[:\-]*/i },
  { key: "securityImpact", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?(?:security impact|impact)\b[:\-]*/i },
  { key: "verifyFirst", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?verify first\b[:\-]*/i },
  { key: "remediationOptions", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?(?:remediation options?|immediate actions)\b[:\-]*/i },
  { key: "escalateIf", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?escalate if\b[:\-]*/i },
  { key: "confidence", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?confidence\b[:\-]*/i },
  { key: "missingData", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?missing data\b[:\-]*/i },
  { key: "howToGetMissingData", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?how to get missing data\b[:\-]*/i }
];

function buildCrashRcaMissingDataRetrieval(crashOs: SupportedOs, missingData: string[]): string[] {
  const lowerItems = missingData.map((item) => item.toLowerCase());
  const steps: string[] = [];

  if (crashOs === "windows") {
    if (lowerItems.some((item) => item.includes("bugcheck"))) {
      steps.push(
        "To retrieve the bugcheck code, first check Windows WER/BugCheck crash events in the System log. PowerShell: `Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001} | Select-Object TimeCreated, Id, ProviderName, Message -First 10`"
      );
    }

    if (lowerItems.some((item) => item.includes("stack trace") || item.includes("instruction pointer") || item.includes("rip"))) {
      steps.push(
        "To retrieve a stack trace, open the dump in WinDbg and load symbols, then run `!analyze -v`, `kv`, and `lm`. This is typically an escalation/engineering step rather than first-line help desk analysis."
      );
    }
  } else if (crashOs === "linux") {
    if (lowerItems.some((item) => item.includes("signal") || item.includes("crash code"))) {
      steps.push(
        "To retrieve the crash signal and nearby process context, review `journalctl` around the crash time and run `coredumpctl info <exe-or-pid>` for the captured core-dump metadata."
      );
    }

    if (lowerItems.some((item) => item.includes("stack trace") || item.includes("backtrace") || item.includes("instruction pointer") || item.includes("rip"))) {
      steps.push(
        "To retrieve a backtrace from a systemd-managed core dump, run `coredumpctl gdb <exe-or-pid>` or `coredumpctl debug <exe-or-pid>`, then capture `bt full` with debug symbols installed when possible."
      );
    }
  }

  if (steps.length === 0) {
    steps.push(
      crashOs === "windows"
        ? "If critical crash evidence is missing, review the nearest System/WER crash events first, then escalate to debugger-based dump analysis if Hermes still cannot prove the root cause."
        : crashOs === "linux"
          ? "If critical crash evidence is missing, review `journalctl` and `coredumpctl info` first, then escalate to debugger-backed core-dump analysis if Hermes still cannot prove the root cause."
          : "If critical crash evidence is missing, review the nearest platform crash logs first, then escalate to debugger-backed dump analysis if Hermes still cannot prove the root cause."
    );
  }

  return steps;
}

function normalizeConfidenceText(value: string): string {
  const trimmed = value
    .trim()
    .replace(/\s*#+\s*why\b[:\-]?\s*/gi, ": ")
    .replace(/\s+/g, " ");
  if (!trimmed || trimmed === "Not specified.") {
    return trimmed;
  }

  const match = trimmed.match(/^(\d{1,3}%)(?:\s*(?:why:|:|-)\s*)?(.*)$/i);
  if (!match) {
    return trimmed;
  }

  const [, percent, remainder] = match;
  const detail = remainder.trim();
  return detail ? `${percent}: ${detail}` : percent;
}

function sanitizeCrashRcaAction(item: string): string {
  const lower = item.toLowerCase();
  const mentionsKernelAsset =
    lower.includes(".sys") ||
    lower.includes("driver") ||
    lower.includes("windows component") ||
    lower.includes("system file");
  const destructive =
    lower.includes("uninstall") ||
    lower.includes("delete") ||
    lower.includes("remove") ||
    lower.includes("force remove");

  if (mentionsKernelAsset && destructive) {
    return "Do not remove kernel drivers or Windows components from RCA output alone. Verify the version, recent changes, and vendor guidance first, then escalate if a rollback is required.";
  }

  if (lower.includes("do not reboot")) {
    return "Preserve current state if safe, collect evidence, and follow the support workflow before disruptive changes.";
  }

  if (lower.includes("reboot")) {
    return "Preserve the dump and current Hermes evidence first, then reboot only after targeted verification if the environment allows interruption.";
  }

  if (lower.includes("symbol-level rollback") || (lower.includes("symbols") && lower.includes("rollback"))) {
    return "High-risk escalation-only: use symbol-backed debugging to confirm the fault domain first, then decide whether a vendor-supported rollback or patch is appropriate under change control.";
  }

  if (lower.includes("clean boot") && (lower.includes("hyper-v") || lower.includes("services disabled"))) {
    return "Use controlled isolation testing only after preserving evidence: verify recent Hyper-V, virtual switch, VPN, or network-filter driver changes first, then disable non-essential related components one change at a time if the environment allows it.";
  }

  if (lower.includes("windows updates") && (lower.includes("hyper-v") || lower.includes("vmswitch"))) {
    return "Review recent Windows, Hyper-V, virtual switch, VPN, or network-filter driver updates and apply relevant vendor-supported fixes for the suspected driver path.";
  }

  return item;
}

function sanitizeCrashVerifyFirstItem(item: string, crashOs: SupportedOs): string {
  let value = item.trim();
  if (/dump file exists and is readable|minidump .*readable|verify minidump .*readable|dump .*readable/i.test(value)) {
    return crashOs === "windows"
      ? "Verify the suspected driver/module file version, signer, and recent Windows Update or rollout history before making changes."
      : "Verify the suspected binary or library version, package provenance, and recent deployment or update history before making changes.";
  }
  if (crashOs === "windows") {
    value = value.replace(/system rebooted without shutdown\s*\(event 41\)[,;]?\s*/i, "");
    value = value.replace(/dump file [^.;]+ available for analysis[,;]?\s*/i, "");
    value = value.replace(/volmgr\s+event\s+16[12][^.;]*[,;]?\s*/i, "");
  }
  value = value.replace(/\s{2,}/g, " ").replace(/\s+([,;:.])/g, "$1").trim();
  if (value.endsWith(",") || value.endsWith(";")) {
    value = value.slice(0, -1).trim();
  }
  return value;
}

function normalizeCrashRiskLevelText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "Not specified.") {
    return trimmed;
  }

  const normalized = trimmed.replace(/\s+/g, " ");
  if (/medium\s*-\s*high/i.test(normalized)) {
    return normalized.replace(/medium\s*-\s*high/i, "High");
  }
  if (/low\s*-\s*medium/i.test(normalized)) {
    return normalized.replace(/low\s*-\s*medium/i, "Medium");
  }
  return normalized;
}

function sanitizeCrashHowToGetMissingDataItem(item: string, crashOs: SupportedOs): string {
  let value = item.trim();
  if (crashOs === "windows") {
    value = value.replace(/Get-WinEvent\s+-FilterHashtable\s+@\{LogName='System';\s*Id=41\}/gi, "Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001}");
    if (/event id 41|id=41|kernel-power/i.test(value) && /bugcheck|crash code/i.test(value)) {
      return "Retrieve the bugcheck code from Windows WER/BugCheck crash events first, for example with `Get-WinEvent -FilterHashtable @{LogName='System'; Id=1001}`. Use Event ID 41 only as crash confirmation context, not as the primary bugcheck source.";
    }
    if (/bluescreenview/i.test(value) || (/windbg/i.test(value) && /bugcheck/i.test(value))) {
      return "Use WinDbg first for authoritative dump analysis: open the minidump, load symbols, and run `!analyze -v`. BlueScreenView is acceptable only as a lightweight quick-look, not as a substitute for debugger-backed analysis.";
    }
  } else if (crashOs === "linux") {
    if (/windbg|bluescreenview/i.test(value)) {
      return "Use `coredumpctl info` for metadata and `coredumpctl gdb` for authoritative core-dump analysis, then capture `bt full` with debug symbols installed when possible.";
    }
  }
  return value;
}

function sanitizeCrashEscalateItem(item: string, crashOs: SupportedOs): string {
  const lower = item.toLowerCase();
  if (crashOs === "windows" && /(event id 1001|wer).*(memory corruption)|memory corruption.*(event id 1001|wer)/i.test(item)) {
    return "Escalate if WER/System Event ID 1001 or WinDbg identifies a bugcheck or stack trace that points outside the current working `vmswitch.sys` hypothesis.";
  }
  if (lower.includes("production stability without further investigation")) {
    return "Escalate if the environment requires rapid stability restoration and the current evidence is still only a working hypothesis.";
  }
  if (lower.includes("system continues to crash") || lower.includes("crash recurs")) {
    return "Escalate if repeated crashes continue after version, signer, and recent update-history verification for the suspected driver path.";
  }
  return item;
}

function sanitizeCrashSummaryText(value: string): string {
  let text = value.trim();
  if (!text) return text;
  text = text.replace(/(pnp|wudfrd) (driver )?(load failures?)/gi, "nearby driver-load instability");
  text = text.replace(/\s{2,}/g, " ");
  return text;
}

function sanitizeCrashLikelyCauseItem(item: string): string {
  let value = ensureCrashHypothesisWording(item, true);
  if (/supporting evidence:/i.test(value) && /wudfrd/i.test(value)) {
    value = value.replace(/WUDFRd[^.;]*?(?=;|$)/i, "nearby WUDFRd-related driver-load instability");
  }
  return value;
}

function ensureCrashHypothesisWording(item: string, hasCriticalCrashGaps: boolean): string {
  if (!hasCriticalCrashGaps) {
    return item;
  }

  if (/working hypothesis|not a confirmed root cause|not yet confirmed/i.test(item)) {
    return item;
  }

  if (/^-\s*/.test(item)) {
    return item;
  }

  if (/most likely rca:/i.test(item)) {
    return `${item} This remains a working hypothesis until the bugcheck code or stack trace confirms it.`;
  }

  if (/remaining uncertainty:/i.test(item)) {
    return `${item} Treat this as a working hypothesis, not a confirmed root cause.`;
  }

  return item;
}

export function normalizeLlmGuide(
  guide: LlmAnalysisGuide,
  contextKind: LlmAnalysisContextKind,
  options?: {
    crashOs?: SupportedOs;
    hasHermesPreCrashEvidence?: boolean;
    hermesIndicatorItems?: string[];
  }
): LlmAnalysisGuide {
  if (contextKind !== "crash-rca") {
    return guide;
  }

  const likelyCauses =
    guide.likelyCauses.length > 0
      ? guide.likelyCauses
      : ["Most likely RCA: The response did not clearly identify a single cause from the available crash evidence."];

  const riskLevel = guide.riskLevel !== "Not specified."
    ? normalizeCrashRiskLevelText(guide.riskLevel)
    : "Medium - A system crash occurred, but the currently loaded evidence does not fully prove the root cause.";

  const securityImpact = guide.securityImpact !== "Not specified."
    ? guide.securityImpact
    : "No direct security impact confirmed from available crash evidence.";

  const remediationOptions =
    guide.remediationOptions.length > 0
      ? guide.remediationOptions.map(sanitizeCrashRcaAction)
      : [
          "Capture the dump, preserve supporting logs, and verify the suspected module or driver version before making changes.",
          "Use vendor-supported update or rollback guidance only after confirming the fault domain."
        ];
  const crashOs = options?.crashOs ?? "windows";
  const hasHermesPreCrashEvidence = options?.hasHermesPreCrashEvidence === true;
  const hermesIndicatorItems = options?.hermesIndicatorItems ?? [];
  const hasCriticalCrashGaps = guide.missingData.some((item) => /bugcheck|signal|stack trace|backtrace|instruction pointer|rip/i.test(item));
  const hermesIndicatorLine =
    hasHermesPreCrashEvidence && hermesIndicatorItems.length > 0
      ? `Hermes found these pre-crash indicators: ${hermesIndicatorItems.join("; ")}`
      : "";
  const verifyFirstBase =
    guide.verifyFirst.length > 0
      ? guide.verifyFirst.filter((item) => {
          if (!hasHermesPreCrashEvidence) return true;
          return !/(event viewer|system log|review .*pre-crash .*warnings|review .*critical errors)/i.test(item);
        }).map((item) => sanitizeCrashVerifyFirstItem(item, crashOs)).filter(Boolean)
      : [];
  const verifyFirst =
    hasHermesPreCrashEvidence && hermesIndicatorLine
      ? [hermesIndicatorLine, ...verifyFirstBase.filter((item) => item !== hermesIndicatorLine)]
      : verifyFirstBase.length > 0
        ? verifyFirstBase
        : [
            crashOs === "windows"
              ? "Review the dump metadata, correlated events, and recent driver or software changes before remediation."
              : crashOs === "linux"
                ? "Review the core-dump metadata, correlated events, and recent package or library changes before remediation."
                : "Review the dump metadata, correlated events, and recent software changes before remediation."
          ];
  const normalizedLikelyCauses = likelyCauses.map((item) => ensureCrashHypothesisWording(item, hasCriticalCrashGaps));
  const sanitizedLikelyCauses = normalizedLikelyCauses.map(sanitizeCrashLikelyCauseItem);
  const sanitizedSummary = sanitizeCrashSummaryText(guide.summary);
  const evidenceGapLabel = crashEvidenceGapLabel(crashOs);
  const defaultMissingData = crashOs === "windows"
    ? "Exact bugcheck code or stronger dump evidence is still needed to prove the RCA."
    : crashOs === "linux"
      ? "Exact signal, backtrace, or stronger core-dump evidence is still needed to prove the RCA."
      : "Exact crash code or stronger dump evidence is still needed to prove the RCA.";

  return {
    ...guide,
    summary: sanitizedSummary,
    likelyCauses: sanitizedLikelyCauses,
    riskLevel,
    securityImpact,
    remediationOptions,
    verifyFirst,
    escalateIf:
      guide.escalateIf.length > 0
        ? guide.escalateIf.map((item) => sanitizeCrashEscalateItem(item, crashOs))
        : ["Escalate if the system continues crashing or the dump evidence is still inconclusive."],
    confidence:
      guide.confidence !== "Not specified."
        ? normalizeConfidenceText(
            /why:/i.test(guide.confidence)
              ? guide.confidence
              : `${guide.confidence}: Hermes has some supporting crash-context evidence, but the exact ${evidenceGapLabel} is still missing. Treat this as a working hypothesis, not a confirmed root cause.`
          )
        : `40%: Hermes has partial crash-context evidence, but key proof points like the ${evidenceGapLabel} are still missing. Treat this as a working hypothesis, not a confirmed root cause.`,
    missingData:
      guide.missingData.length > 0
        ? guide.missingData
        : [defaultMissingData],
    howToGetMissingData:
      guide.howToGetMissingData.length > 0
        ? guide.howToGetMissingData.map((item) => sanitizeCrashHowToGetMissingDataItem(item, crashOs))
        : buildCrashRcaMissingDataRetrieval(
            crashOs,
            guide.missingData.length > 0
              ? guide.missingData
              : [defaultMissingData]
          )
  };
}

function stripLlmScratchpadNoise(raw: string): string {
  const noisyPrefix = /^(?:\*+\s*)?(?:wait|let'?s|lets|okay\b|i need to|i will|self-correction|rule \d+|date anomaly|security flag)\b/i;
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      const normalized = trimmed.replace(/^[>\-*•\s]+/, "");
      return !noisyPrefix.test(normalized);
    })
    .join("\n")
    .trim();
}

function extractGuideItem(line: string): string {
  return line
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

export function parseLlmGuide(raw: string): LlmAnalysisGuide {
  const cleanedRaw = stripLlmScratchpadNoise(raw);
  const buckets = {
    summary: [] as string[],
    likelyCauses: [] as string[],
    riskLevel: [] as string[],
    securityImpact: [] as string[],
    verifyFirst: [] as string[],
    remediationOptions: [] as string[],
    escalateIf: [] as string[],
    confidence: [] as string[],
    missingData: [] as string[],
    howToGetMissingData: [] as string[]
  };
  const preface: string[] = [];
  let currentKey: keyof typeof buckets | null = null;

  for (const sourceLine of cleanedRaw.split("\n")) {
    const line = sourceLine.trim();
    if (!line) continue;

    const matchedSection = llmGuideSectionMatchers.find((entry) => entry.regex.test(line));
    if (matchedSection) {
      currentKey = matchedSection.key;
      const remainder = extractGuideItem(line.replace(matchedSection.regex, "").trim());
      if (remainder) buckets[currentKey].push(remainder);
      continue;
    }

    const item = extractGuideItem(line);
    if (!item) continue;
    if (currentKey) {
      buckets[currentKey].push(item);
    } else {
      preface.push(item);
    }
  }

  const summary = buckets.summary[0] ?? preface[0] ?? "No summary returned.";
  const riskLevel = buckets.riskLevel[0] ?? "Not specified.";
  const securityImpact = buckets.securityImpact[0] ?? "Not specified.";
  const confidence = buckets.confidence.length > 0 ? buckets.confidence.join(" ") : "Not specified.";

  const likelyCauses = buckets.likelyCauses.slice(0, 3);
  const verifyFirst = buckets.verifyFirst.slice(0, 6);
  const remediationOptions = buckets.remediationOptions.slice(0, 6);
  const escalateIf = buckets.escalateIf.slice(0, 4);
  const missingData = buckets.missingData.slice(0, 6);
  const howToGetMissingData = buckets.howToGetMissingData.slice(0, 6);

  return {
    summary,
    likelyCauses,
    riskLevel,
    securityImpact,
    verifyFirst,
    remediationOptions,
    escalateIf,
    confidence,
    missingData,
    howToGetMissingData,
    cleanedRaw
  };
}

export function guideLabelsForContext(contextKind: LlmAnalysisContextKind) {
  if (contextKind === "crash-rca") {
    return {
      title: "Hermes Crash RCA",
      section2: "Most Likely RCA",
      section6: "Immediate Actions"
    };
  }
  return {
    title: "Hermes Troubleshooting Guide",
    section2: "Likely Causes",
    section6: "Remediation Options"
  };
}
