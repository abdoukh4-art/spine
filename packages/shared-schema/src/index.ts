/**
 * @packageDocumentation
 * `@spine/shared-schema` — the single source of truth for Spine's data contracts
 * (ADR-0005). Zod schemas give runtime validation, `z.infer` gives static types, and
 * the API generates its OpenAPI document from the same objects.
 */
export * from './common.js';
export * from './condition.js';
export * from './condition-eval.js';
export * from './alert.js';
export * from './enrichment.js';
export * from './scoring.js';
export * from './playbook.js';
export * from './auth.js';
export * from './metrics.js';
export * from './events.js';
export * from './api.js';
