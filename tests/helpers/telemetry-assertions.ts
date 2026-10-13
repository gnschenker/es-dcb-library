import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

const FORBIDDEN_ATTRIBUTE_KEYS = new Set([
  'data',
  'metadata',
  'tags',
  'db.statement',
  'dcb.tag',
]);

export function assertSpanAttributesSafe(span: ReadableSpan): void {
  const attrs = span.attributes;
  for (const key of Object.keys(attrs)) {
    if (FORBIDDEN_ATTRIBUTE_KEYS.has(key)) {
      throw new Error(`forbidden attribute key on span ${span.name}: ${key}`);
    }
    if (key.includes('payload')) {
      throw new Error(`forbidden attribute key on span ${span.name}: ${key}`);
    }
  }
  for (const value of Object.values(attrs)) {
    if (typeof value === 'string' && value.includes('order:')) {
      throw new Error(`span ${span.name} attribute value looks like a tag: ${value}`);
    }
  }
}

export function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}
