import type { Tier } from "../routing/types.ts";

/** Per-1M-token input cost by tier */
const COST_PER_MILLION: Record<Tier, number> = {
  LIGHT: 0.25,
  MEDIUM: 3.0,
  HEAVY: 15.0,
};

const BASELINE_COST_PER_MILLION = COST_PER_MILLION.HEAVY;

export interface StatsSnapshot {
  totalRequests: number;
  byTier: { LIGHT: number; MEDIUM: number; HEAVY: number };
  estimatedCost: number;
  baselineCost: number;
  savings: string;
  compressions: { total: number; avgRatio: number };
  startedAt: string;
  uptime: string;
}

export interface StatsTracker {
  recordRequest(tier: Tier, model: string, inputTokens: number, estimatedCost: number): void;
  recordCompression(originalTokens: number, compressedTokens: number): void;
  getStats(): StatsSnapshot;
  reset(): void;
}

interface InternalStats {
  totalRequests: number;
  byTier: { LIGHT: number; MEDIUM: number; HEAVY: number };
  estimatedCost: number;
  baselineCost: number;
  compressions: { total: number; totalOriginalTokens: number; totalCompressedTokens: number };
  startedAt: number;
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatSavings(estimatedCost: number, baselineCost: number): string {
  if (baselineCost === 0) return "0%";
  return ((1 - estimatedCost / baselineCost) * 100).toFixed(0) + "%";
}

export function createStatsTracker(): StatsTracker {
  let stats: InternalStats = {
    totalRequests: 0,
    byTier: { LIGHT: 0, MEDIUM: 0, HEAVY: 0 },
    estimatedCost: 0,
    baselineCost: 0,
    compressions: { total: 0, totalOriginalTokens: 0, totalCompressedTokens: 0 },
    startedAt: Date.now(),
  };

  return {
    recordRequest(_tier: Tier, _model: string, inputTokens: number, estimatedCost: number): void {
      stats.totalRequests++;
      stats.byTier[_tier]++;
      stats.estimatedCost += estimatedCost;
      stats.baselineCost += (inputTokens / 1_000_000) * BASELINE_COST_PER_MILLION;
    },

    recordCompression(originalTokens: number, compressedTokens: number): void {
      stats.compressions.total++;
      stats.compressions.totalOriginalTokens += originalTokens;
      stats.compressions.totalCompressedTokens += compressedTokens;
    },

    getStats(): StatsSnapshot {
      const { compressions } = stats;
      const avgRatio = compressions.total > 0
        ? compressions.totalCompressedTokens / compressions.totalOriginalTokens
        : 0;

      return {
        totalRequests: stats.totalRequests,
        byTier: { ...stats.byTier },
        estimatedCost: stats.estimatedCost,
        baselineCost: stats.baselineCost,
        savings: formatSavings(stats.estimatedCost, stats.baselineCost),
        compressions: {
          total: compressions.total,
          avgRatio,
        },
        startedAt: new Date(stats.startedAt).toISOString(),
        uptime: formatUptime(Date.now() - stats.startedAt),
      };
    },

    reset(): void {
      stats = {
        totalRequests: 0,
        byTier: { LIGHT: 0, MEDIUM: 0, HEAVY: 0 },
        estimatedCost: 0,
        baselineCost: 0,
        compressions: { total: 0, totalOriginalTokens: 0, totalCompressedTokens: 0 },
        startedAt: Date.now(),
      };
    },
  };
}

export function createStatsHandler(tracker: StatsTracker): (req: Request, body: unknown) => Promise<Response> {
  return async () => {
    const snapshot = tracker.getStats();
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
