import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics
} from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({
  register: registry,
  prefix: 'buildora_'
});

const labelNames = ['channel'] as const;

export const messagesInboundTotal = new Counter({
  name: 'messages_inbound_total',
  help: 'Number of inbound messages received per channel',
  labelNames
});

export const messagesOutboundTotal = new Counter({
  name: 'messages_outbound_total',
  help: 'Number of outbound messages sent per channel',
  labelNames: [...labelNames, 'type']
});

export const replyLatencySeconds = new Histogram({
  name: 'reply_latency_seconds',
  help: 'Latency between last inbound user message and assistant reply',
  labelNames: ['channel'],
  buckets: [5, 10, 30, 60, 120, 300, 600, 900, 1800]
});

export const bookRate = new Counter({
  name: 'book_rate',
  help: 'Bookings initiated by the assistant (count for rate calculations)',
  labelNames
});

export const errorRate = new Counter({
  name: 'error_rate',
  help: 'Errors encountered by the assistant',
  labelNames: ['component']
});

registry.registerMetric(messagesInboundTotal);
registry.registerMetric(messagesOutboundTotal);
registry.registerMetric(replyLatencySeconds);
registry.registerMetric(bookRate);
registry.registerMetric(errorRate);

export async function metricsSnapshot(): Promise<string> {
  return registry.metrics();
}
