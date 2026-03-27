import { describe, expect, it } from "vitest";

import { buildCrashRcaPrompt } from "./llmPrompt";
import type { CrashRecord, NormalizedEvent } from "../types/events";

function createCrash(overrides: Partial<CrashRecord> = {}): CrashRecord {
  return {
    id: "crash-linux-1",
    timestamp: "2026-03-27T12:00:00Z",
    os: "linux",
    source: "systemd-coredump",
    crashType: "Core Dump",
    code: "SIGSEGV",
    summary: "Example process crashed with SIGSEGV",
    suspectedComponent: "libfoo.so",
    rawPath: "/var/lib/systemd/coredump/core.foo.123",
    sourceHost: "localhost",
    imported: false,
    ...overrides
  };
}

function createEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: "event-1",
    timestamp: "2026-03-27T11:58:00Z",
    os: "linux",
    logName: "system",
    category: "system",
    provider: "kernel",
    eventId: 1000,
    severity: "error",
    message: "segfault at 0 ip 00007f error 4 in libfoo.so",
    sourceHost: "localhost",
    imported: false,
    ...overrides
  };
}

describe("buildCrashRcaPrompt", () => {
  it("uses Linux-specific core-dump retrieval guidance", () => {
    const prompt = buildCrashRcaPrompt(
      {
        crash: createCrash(),
        hostOsVersion: "Garuda Linux",
        minidumpSummary: "Hermes parsed a Linux core dump and found a SIGSEGV in libfoo.so.",
        minidumpDetails: [
          "Dump kind: core_dump",
          "Signal code: SIGSEGV",
          "Suspected component: libfoo.so"
        ],
        likelyCause: "Likely application fault in libfoo.so.",
        verifyFirst: ["Confirm package version and recent updates for libfoo.so."],
        escalateIf: ["Crash recurs after package verification."],
        preCrashEvents: [createEvent()],
        correlatedEvents: [
          createEvent({
            id: "event-2",
            timestamp: "2026-03-27T12:00:15Z",
            provider: "systemd-coredump",
            eventId: 2001,
            message: "Process dumped core after SIGSEGV."
          })
        ],
        sessionCoverage: "15 minutes before crash through 15 minutes after crash",
        severityMetrics: [{ label: "error", count: 3 }],
        providerMetrics: [{ label: "kernel", count: 2 }],
        logTypeMetrics: [{ label: "system", count: 3 }],
        noisySourceMetrics: [{ label: "kernel (error)", count: 2 }],
        relevantExcerpts: ["kernel: segfault at 0 ip 00007f error 4 in libfoo.so"],
        contextReadinessNote: "Linux crash evidence is loaded."
      },
      false
    );

    expect(prompt).toContain("Core Dump Triage Summary:");
    expect(prompt).toContain("journalctl");
    expect(prompt).toContain("coredumpctl info");
    expect(prompt).toContain("coredumpctl gdb");
    expect(prompt).not.toContain("Event Viewer/System logs");
    expect(prompt).not.toContain("WinDbg");
  });
});
