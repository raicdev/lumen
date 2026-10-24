import type { CompatReport } from "../../shared/extensions";

/** A VS Code extension's compatibility in six steps: partial ones split by how much of them works. */
export type CompatGrade = "full" | "high" | "medium" | "low" | "limited" | "unsupported";

export const COMPAT_GRADES: Record<CompatGrade, { label: string; badge: string; text: string }> = {
  full: { label: "Supported", badge: "compatible", text: "Everything this extension uses works in Lumen." },
  high: { label: "Mostly supported", badge: "mostly", text: "Most of what it uses works in Lumen; a few features are missing or limited." },
  medium: { label: "Partially supported", badge: "partial", text: "About half of what it uses works in Lumen; expect some of its features to be missing." },
  low: { label: "Barely supported", badge: "barely", text: "Little of what it uses works in Lumen; most of its features will be missing." },
  limited: { label: "Limited", badge: "limited", text: "Core features it relies on are not available in Lumen; it may not work." },
  unsupported: { label: "Unsupported", badge: "unsupported", text: "None of the APIs and contribution points it uses work in Lumen; it will not work." },
};

/** No report (not analyzed yet) reads as a plain partial. */
export function compatGrade(report: CompatReport | undefined): CompatGrade {
  if (!report) return "medium";
  if (report.level !== "partial") return report.level;
  return report.partialGrade ?? "medium";
}

/** Classes for a compatibility color: `compat-partial compat-grade-high`, `compat-full`, … */
export function compatClass(report: CompatReport | undefined): string {
  const level = report?.level ?? "partial";
  return level === "partial" ? `compat-partial compat-grade-${compatGrade(report)}` : `compat-${level}`;
}
