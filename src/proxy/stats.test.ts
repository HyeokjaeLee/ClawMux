import { describe, expect, it } from "bun:test";
import { createStatsTracker, createStatsHandler } from "./stats.ts";

describe("createStatsTracker", () => {
  it("starts with zero counters", () => {
    const tracker = createStatsTracker();
    const stats = tracker.getStats();

    expect(stats.totalRequests).toBe(0);
    expect(stats.byTier.LIGHT).toBe(0);
    expect(stats.byTier.MEDIUM).toBe(0);
    expect(stats.byTier.HEAVY).toBe(0);
    expect(stats.estimatedCost).toBe(0);
    expect(stats.baselineCost).toBe(0);
    expect(stats.savings).toBe("0%");
    expect(stats.compressions.total).toBe(0);
    expect(stats.compressions.avgRatio).toBe(0);
  });

  it("recordRequest increments totalRequests and per-tier counts", () => {
    const tracker = createStatsTracker();

    tracker.recordRequest("LIGHT", "claude-3-haiku", 1000, 0.00025);
    tracker.recordRequest("MEDIUM", "claude-3-sonnet", 2000, 0.006);
    tracker.recordRequest("HEAVY", "claude-3-opus", 3000, 0.045);

    const stats = tracker.getStats();
    expect(stats.totalRequests).toBe(3);
    expect(stats.byTier.LIGHT).toBe(1);
    expect(stats.byTier.MEDIUM).toBe(1);
    expect(stats.byTier.HEAVY).toBe(1);
  });

  it("accumulates estimated cost", () => {
    const tracker = createStatsTracker();

    tracker.recordRequest("LIGHT", "m", 1000, 0.00025);
    tracker.recordRequest("LIGHT", "m", 1000, 0.00025);

    const stats = tracker.getStats();
    expect(stats.estimatedCost).toBeCloseTo(0.0005, 6);
  });

  it("calculates baseline cost assuming all requests at HEAVY tier ($15/1M)", () => {
    const tracker = createStatsTracker();

    tracker.recordRequest("LIGHT", "m", 1_000_000, 0.25);

    const stats = tracker.getStats();
    expect(stats.baselineCost).toBeCloseTo(15.0, 2);
  });

  it("calculates savings percentage correctly", () => {
    const tracker = createStatsTracker();

    tracker.recordRequest("LIGHT", "m", 1_000_000, 0.25);

    const stats = tracker.getStats();
    // baseline = 15.0, estimated = 0.25, savings = (1 - 0.25/15) * 100 = 98%
    expect(stats.savings).toBe("98%");
  });

  it("savings returns 0% when baseline cost is zero", () => {
    const tracker = createStatsTracker();
    const stats = tracker.getStats();
    expect(stats.savings).toBe("0%");
  });

  it("recordCompression updates compression stats", () => {
    const tracker = createStatsTracker();

    tracker.recordCompression(1000, 500);
    tracker.recordCompression(2000, 600);

    const stats = tracker.getStats();
    expect(stats.compressions.total).toBe(2);
    // avgRatio = (500 + 600) / (1000 + 2000) = 1100/3000 = 0.3667
    expect(stats.compressions.avgRatio).toBeCloseTo(1100 / 3000, 4);
  });

  it("getStats returns all required fields", () => {
    const tracker = createStatsTracker();
    const stats = tracker.getStats();

    expect(stats).toHaveProperty("totalRequests");
    expect(stats).toHaveProperty("byTier");
    expect(stats).toHaveProperty("estimatedCost");
    expect(stats).toHaveProperty("baselineCost");
    expect(stats).toHaveProperty("savings");
    expect(stats).toHaveProperty("compressions");
    expect(stats).toHaveProperty("startedAt");
    expect(stats).toHaveProperty("uptime");
  });

  it("startedAt is a valid ISO timestamp", () => {
    const tracker = createStatsTracker();
    const stats = tracker.getStats();

    expect(new Date(stats.startedAt).getTime()).not.toBeNaN();
  });

  it("reset clears everything and sets new startedAt", () => {
    const tracker = createStatsTracker();

    tracker.recordRequest("LIGHT", "m", 1000, 0.00025);
    tracker.recordCompression(1000, 500);

    const before = tracker.getStats();
    expect(before.totalRequests).toBe(1);

    tracker.reset();

    const after = tracker.getStats();
    expect(after.totalRequests).toBe(0);
    expect(after.byTier.LIGHT).toBe(0);
    expect(after.estimatedCost).toBe(0);
    expect(after.baselineCost).toBe(0);
    expect(after.compressions.total).toBe(0);
    expect(after.compressions.avgRatio).toBe(0);
  });
});

describe("uptime formatting", () => {
  it("returns minutes-only format for short uptime", () => {
    const tracker = createStatsTracker();
    const stats = tracker.getStats();

    // Just created, so uptime should be "0m"
    expect(stats.uptime).toMatch(/^\d+m$/);
  });
});

describe("createStatsHandler", () => {
  it("returns 200 JSON response with StatsSnapshot", async () => {
    const tracker = createStatsTracker();
    const handler = createStatsHandler(tracker);

    tracker.recordRequest("LIGHT", "m", 1000, 0.00025);

    const response = await handler(new Request("http://localhost/stats"), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body = await response.json() as Record<string, unknown>;
    expect(body.totalRequests).toBe(1);
    expect(body.byTier).toEqual({ LIGHT: 1, MEDIUM: 0, HEAVY: 0 });
    expect(body.savings).toBe("98%");
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.uptime).toBe("string");
  });
});
