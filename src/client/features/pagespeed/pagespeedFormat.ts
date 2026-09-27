import type { PageSpeedRating } from "@/shared/pagespeed";

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function formatCls(cls: number | null | undefined): string {
  return cls == null ? "—" : cls.toFixed(2);
}

export function scoreTone(score: number | null | undefined): string {
  if (score == null) return "text-base-content/50";
  if (score >= 90) return "text-success";
  if (score >= 50) return "text-warning";
  return "text-error";
}

export const RATING_LABELS: Record<PageSpeedRating, string> = {
  good: "Good",
  needs_improvement: "Needs improvement",
  poor: "Poor",
};

export function formatDelta(delta: number | null | undefined) {
  if (delta == null || delta === 0) return null;
  return {
    text: `${delta > 0 ? "+" : ""}${delta}`,
    tone: delta > 0 ? "text-success" : "text-error",
  };
}
