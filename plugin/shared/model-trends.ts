// JSON wire shapes mirrored from the server; shared/ stays self-contained.
export interface MetricTrend {
  unit: string;
  sampleUnit: 'request' | 'task' | 'snapshot';
  current?: number; ewma?: number; slopePerMinute?: number;
  samples: number; lastSampleAt?: string; ageMs?: number; sufficient: boolean;
  change: { detected: boolean; direction?: 'up' | 'down'; at?: string; before?: number; after?: number };
  baseline: { samples: number; mean?: number };
  windows: Record<string, { samples: number; mean?: number; p50?: number; p90?: number }>;
}
export type ModelTrends = Record<string, MetricTrend>;
