export type NewsCategory = "calendar" | "central_bank" | "world" | "crypto" | "corporate";
export interface NewsAsset { symbol: string; name: string; kind: string; isOtc: boolean; isActive: boolean }
export interface NewsEvent {
  id: string;
  eventKey: string;
  source: string;
  category: NewsCategory;
  title: string;
  url: string;
  publishedAt: number | null;
  scheduledAt: number | null;
  firstSeenAt: number;
  impact: "high" | "medium" | "low" | "unknown";
  currencies: string[];
  assets: string[];
  tags: string[];
  forecast: string | null;
  previous: string | null;
  actual: string | null;
}
export interface NewsSource {
  id: string; label: string; url: string; category: NewsCategory;
  intervalSec: number; staleSec: number; currency?: string; asset?: string;
}
export interface SourceHealth {
  source: string; checkedAt: number; lastOkAt: number | null;
  nextFetchAt: number; failures: number; items: number; error: string | null;
}
export interface NewsAssessment {
  version: string; mode: "shadow"; symbol: string; asOf: number;
  risk: number | null; proposedConfidenceMultiplier: number | null;
  liveConfidenceMultiplier: 1; direction: null;
  events: { id: string; title: string; source: string; phase: "before" | "after"; secondsToEvent: number; risk: number; url: string }[];
  gaps: string[];
}

export interface NewsHeartbeat {
  version: string; mode: "shadow"; appliedToLive: false; checkedAt: number;
  assets: number; activeAssets: number;
  sources: { id: string; label: string; url: string; intervalSec: number }[];
  failedSources: string[]; calendarActualAvailable: boolean; gaps: string[];
  runtime?: { pid: number; node: string };
}
export interface NewsOverview {
  status: NewsHeartbeat | null;
  counts: { events: number; assessments: number; signals: number; measured_reactions: number; missing_reactions: number };
  sources: SourceHealth[]; assessments: NewsAssessment[];
}