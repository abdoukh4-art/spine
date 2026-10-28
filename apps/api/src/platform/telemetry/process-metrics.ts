import type { Meter } from '@opentelemetry/api';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Process vital signs without an extra dependency (USE method: utilisation, saturation):
 *
 * - `spine_process_cpu_seconds_total{mode}`: CPU time (user/system), from `process.cpuUsage()`.
 * - `spine_process_resident_memory_bytes`, `spine_process_heap_used_bytes`.
 * - `spine_nodejs_eventloop_delay_p99_seconds`: event-loop saturation, the first thing
 *   to look at when a Node service is "slow but not busy".
 *
 * Names are prefixed `spine_` so they never collide with a future prom-client or
 * host-metrics exporter. All are observed on scrape, so they cost nothing in between.
 */
export function registerProcessMetrics(meter: Meter): void {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  meter
    .createObservableCounter('spine_process_cpu_seconds', {
      description: 'CPU time consumed by the process, by mode',
    })
    .addCallback((result) => {
      const usage = process.cpuUsage();
      result.observe(usage.user / 1e6, { mode: 'user' });
      result.observe(usage.system / 1e6, { mode: 'system' });
    });
  meter
    .createObservableGauge('spine_process_resident_memory_bytes', {
      description: 'Resident set size of the process',
    })
    .addCallback((result) => {
      result.observe(process.memoryUsage.rss());
    });
  meter
    .createObservableGauge('spine_process_heap_used_bytes', { description: 'V8 heap in use' })
    .addCallback((result) => {
      result.observe(process.memoryUsage().heapUsed);
    });
  meter
    .createObservableGauge('spine_nodejs_eventloop_delay_p99_seconds', {
      description: 'p99 event-loop delay since the previous scrape',
    })
    .addCallback((result) => {
      result.observe(loopDelay.percentile(99) / 1e9);
      loopDelay.reset();
    });
}
