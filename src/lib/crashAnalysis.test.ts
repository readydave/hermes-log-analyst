import { describe, expect, it } from "vitest";

import { isDumpBackedCrash, normalizeLlmGuide, parseLlmGuide } from "./crashAnalysis";
import type { CrashRecord } from "../types/events";

function createCrash(overrides: Partial<CrashRecord> = {}): CrashRecord {
  return {
    id: "crash-1",
    timestamp: "2026-03-27T12:00:00Z",
    os: "linux",
    source: "systemd-coredump",
    crashType: "Core Dump",
    code: "SIGSEGV",
    summary: "Application crashed with SIGSEGV",
    suspectedComponent: "libfoo.so",
    rawPath: "/var/lib/systemd/coredump/core.foo.123",
    sourceHost: "localhost",
    imported: false,
    ...overrides
  };
}

describe("crashAnalysis", () => {
  it("recognizes Linux core dumps and Windows dump-backed crashes", () => {
    expect(
      isDumpBackedCrash(
        createCrash({
          os: "linux",
          source: "systemd-coredump",
          crashType: "Core Dump"
        })
      )
    ).toBe(true);

    expect(
      isDumpBackedCrash(
        createCrash({
          os: "windows",
          source: "Minidump",
          crashType: "Minidump"
        })
      )
    ).toBe(true);

    expect(
      isDumpBackedCrash(
        createCrash({
          os: "windows",
          source: "KernelDump",
          crashType: "Kernel Memory Dump"
        })
      )
    ).toBe(true);

    expect(
      isDumpBackedCrash(
        createCrash({
          os: "linux",
          source: "journalctl",
          crashType: "Application Error"
        })
      )
    ).toBe(false);
  });

  it("normalizes Linux crash RCA guidance with Hermes indicators and coredump retrieval steps", () => {
    const guide = normalizeLlmGuide(
      {
        summary: "Possible crash in libfoo.so",
        likelyCauses: ["Most likely RCA: libfoo.so faulted during request handling."],
        riskLevel: "Medium - High",
        securityImpact: "Not specified.",
        verifyFirst: [
          "Review Event Viewer for pre-crash warnings.",
          "Verify dump file exists and is readable."
        ],
        remediationOptions: [],
        escalateIf: [],
        confidence: "62%",
        missingData: ["Signal code is not confirmed.", "Full backtrace is still missing."],
        howToGetMissingData: [],
        cleanedRaw: "raw"
      },
      "crash-rca",
      {
        crashOs: "linux",
        hasHermesPreCrashEvidence: true,
        hermesIndicatorItems: [
          "kernel: segfault at 0 ip 00007f...",
          "systemd-coredump captured the process crash"
        ]
      }
    );

    expect(guide.verifyFirst[0]).toBe(
      "Hermes found these pre-crash indicators: kernel: segfault at 0 ip 00007f...; systemd-coredump captured the process crash"
    );
    expect(guide.verifyFirst).toContain(
      "Verify the suspected binary or library version, package provenance, and recent deployment or update history before making changes."
    );
    expect(guide.riskLevel).toBe("High");
    expect(guide.securityImpact).toBe("No direct security impact confirmed from available crash evidence.");
    expect(guide.howToGetMissingData.join(" ")).toContain("journalctl");
    expect(guide.howToGetMissingData.join(" ")).toContain("coredumpctl info");
    expect(guide.howToGetMissingData.join(" ")).toContain("coredumpctl gdb");
  });

  it("parses guide markdown and strips scratchpad noise", () => {
    const guide = parseLlmGuide(`
Wait, I need to think.
## Summary
- Linux crash likely originated in libfoo.so
## Likely Causes
- Most likely RCA: libfoo.so accessed invalid memory.
## Verify First
- Confirm the captured core-dump metadata matches the failing binary.
## Confidence
- 55%
## Missing Data
- Signal code is not confirmed.
`);

    expect(guide.cleanedRaw).not.toContain("Wait, I need to think");
    expect(guide.summary).toBe("Linux crash likely originated in libfoo.so");
    expect(guide.likelyCauses[0]).toBe("Most likely RCA: libfoo.so accessed invalid memory.");
    expect(guide.verifyFirst[0]).toBe("Confirm the captured core-dump metadata matches the failing binary.");
    expect(guide.missingData[0]).toBe("Signal code is not confirmed.");
  });
});
