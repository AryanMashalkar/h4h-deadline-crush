/** Minimal Prometheus-format metrics: request counts and latency buckets per route. */
const BUCKETS = [5, 10, 25, 50, 100, 200, 500, 1000, 2500];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}

export class Metrics {
  private requests = new Map<string, number>();
  private latency = new Map<string, Series>();

  observe(route: string, method: string, status: number, ms: number) {
    const rk = `method="${method}",route="${route}",status="${status}"`;
    this.requests.set(rk, (this.requests.get(rk) ?? 0) + 1);
    const lk = `method="${method}",route="${route}"`;
    let s = this.latency.get(lk);
    if (!s) this.latency.set(lk, (s = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) }));
    s.count++;
    s.sum += ms;
    BUCKETS.forEach((b, i) => {
      if (ms <= b) s!.buckets[i]!++;
    });
  }

  render(gauges: Record<string, number>): string {
    const out: string[] = ['# TYPE http_requests_total counter'];
    for (const [k, v] of this.requests) out.push(`http_requests_total{${k}} ${v}`);
    out.push('# TYPE http_request_duration_ms histogram');
    for (const [k, s] of this.latency) {
      BUCKETS.forEach((b, i) => out.push(`http_request_duration_ms_bucket{${k},le="${b}"} ${s.buckets[i]}`));
      out.push(`http_request_duration_ms_bucket{${k},le="+Inf"} ${s.count}`);
      out.push(`http_request_duration_ms_sum{${k}} ${s.sum.toFixed(1)}`);
      out.push(`http_request_duration_ms_count{${k}} ${s.count}`);
    }
    for (const [k, v] of Object.entries(gauges)) out.push(`# TYPE ${k} gauge`, `${k} ${v}`);
    return out.join('\n') + '\n';
  }
}
