/**
 * Performance Measurement Utilities
 *
 * Helpers for performance testing and benchmarking:
 * - Measuring execution time
 * - Statistical analysis (mean, median, p95, p99)
 * - Performance assertions
 * - Benchmark reporting
 */

export interface PerformanceSample {
  duration: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface PerformanceStats {
  samples: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  stdDev: number;
}

export class PerformanceMeasure {
  private samples: PerformanceSample[] = [];

  /**
   * Measure a single execution
   */
  async measure<T>(
    fn: () => Promise<T>,
    metadata?: Record<string, any>,
  ): Promise<T> {
    const startTime = performance.now();
    const result = await fn();
    const duration = performance.now() - startTime;

    this.samples.push({
      duration,
      timestamp: Date.now(),
      metadata,
    });

    return result;
  }

  /**
   * Measure multiple executions
   */
  async measureMultiple<T>(
    fn: () => Promise<T>,
    iterations: number,
    metadata?: Record<string, any>,
  ): Promise<T[]> {
    const results: T[] = [];

    for (let i = 0; i < iterations; i++) {
      const result = await this.measure(fn, {
        ...metadata,
        iteration: i,
      });
      results.push(result);
    }

    return results;
  }

  /**
   * Measure with warmup iterations
   */
  async measureWithWarmup<T>(
    fn: () => Promise<T>,
    warmupIterations: number,
    measureIterations: number,
    metadata?: Record<string, any>,
  ): Promise<void> {
    console.log(`🔥 Warming up (${warmupIterations} iterations)...`);

    // Warmup phase (not measured)
    for (let i = 0; i < warmupIterations; i++) {
      await fn();
    }

    console.log(`📊 Measuring (${measureIterations} iterations)...`);

    // Measurement phase
    await this.measureMultiple(fn, measureIterations, metadata);
  }

  /**
   * Get performance statistics
   */
  getStats(): PerformanceStats {
    if (this.samples.length === 0) {
      throw new Error('No samples collected');
    }

    const durations = this.samples.map((s) => s.duration).sort((a, b) => a - b);

    const sum = durations.reduce((acc, d) => acc + d, 0);
    const mean = sum / durations.length;

    const variance =
      durations.reduce((acc, d) => acc + Math.pow(d - mean, 2), 0) /
      durations.length;
    const stdDev = Math.sqrt(variance);

    return {
      samples: durations.length,
      min: durations[0],
      max: durations[durations.length - 1],
      mean,
      median: this.percentile(durations, 50),
      p95: this.percentile(durations, 95),
      p99: this.percentile(durations, 99),
      stdDev,
    };
  }

  /**
   * Calculate percentile
   */
  private percentile(sortedValues: number[], percentile: number): number {
    const index = (percentile / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;

    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }

  /**
   * Assert performance meets threshold
   */
  assertPerformance(metric: keyof PerformanceStats, threshold: number): void {
    const stats = this.getStats();
    const value = stats[metric];

    if (typeof value !== 'number') {
      throw new Error(`Invalid metric: ${metric}`);
    }

    if (value > threshold) {
      throw new Error(
        `Performance assertion failed: ${metric} = ${value.toFixed(2)}ms exceeds threshold of ${threshold}ms\n` +
          `Stats: ${JSON.stringify(stats, null, 2)}`,
      );
    }
  }

  /**
   * Print performance report
   */
  printReport(title: string): void {
    const stats = this.getStats();

    console.log(`\n📊 Performance Report: ${title}`);
    console.log('━'.repeat(60));
    console.log(`Samples:       ${stats.samples}`);
    console.log(`Min:           ${stats.min.toFixed(2)}ms`);
    console.log(`Max:           ${stats.max.toFixed(2)}ms`);
    console.log(`Mean:          ${stats.mean.toFixed(2)}ms`);
    console.log(`Median:        ${stats.median.toFixed(2)}ms`);
    console.log(`P95:           ${stats.p95.toFixed(2)}ms`);
    console.log(`P99:           ${stats.p99.toFixed(2)}ms`);
    console.log(`Std Dev:       ${stats.stdDev.toFixed(2)}ms`);
    console.log('━'.repeat(60));
  }

  /**
   * Reset samples
   */
  reset(): void {
    this.samples = [];
  }

  /**
   * Get raw samples
   */
  getSamples(): PerformanceSample[] {
    return [...this.samples];
  }
}

/**
 * Quick one-off performance measurement
 */
export async function quickMeasure<T>(
  name: string,
  fn: () => Promise<T>,
  iterations = 10,
): Promise<PerformanceStats> {
  const measure = new PerformanceMeasure();
  await measure.measureMultiple(fn, iterations);
  const stats = measure.getStats();

  console.log(`\n⚡ ${name}: ${stats.mean.toFixed(2)}ms (p95: ${stats.p95.toFixed(2)}ms)`);

  return stats;
}

/**
 * Compare two performance measurements
 */
export function comparePerformance(
  baseline: PerformanceStats,
  current: PerformanceStats,
): {
  improvement: number;
  regression: boolean;
  percentChange: number;
} {
  const percentChange = ((current.mean - baseline.mean) / baseline.mean) * 100;
  const regression = percentChange > 0; // Slower is regression

  return {
    improvement: baseline.mean - current.mean,
    regression,
    percentChange,
  };
}

/**
 * Create a performance summary table
 */
export function createPerformanceTable(
  results: Record<string, PerformanceStats>,
): string {
  const headers = ['Metric', 'Mean (ms)', 'P95 (ms)', 'P99 (ms)', 'Samples'];
  const rows: string[][] = [];

  for (const [name, stats] of Object.entries(results)) {
    rows.push([
      name,
      stats.mean.toFixed(2),
      stats.p95.toFixed(2),
      stats.p99.toFixed(2),
      stats.samples.toString(),
    ]);
  }

  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  // Build table
  const separator = widths.map((w) => '─'.repeat(w + 2)).join('┼');
  const formatRow = (cells: string[]) =>
    cells.map((cell, i) => ` ${cell.padEnd(widths[i])} `).join('│');

  const lines = [
    formatRow(headers),
    separator,
    ...rows.map((row) => formatRow(row)),
  ];

  return lines.join('\n');
}
