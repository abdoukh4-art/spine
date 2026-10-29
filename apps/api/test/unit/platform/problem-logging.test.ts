import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { OverloadedError } from '../../../src/platform/errors.js';
import { registerProblemHandlers } from '../../../src/platform/http/problem.js';

/** Builds a bare server whose log lines are captured as parsed JSON. */
async function serverThatThrows(error: Error) {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    },
  });
  const app = Fastify({ loggerInstance: pino(stream), disableRequestLogging: true });
  // The pino-typed instance is a FastifyInstance with a narrower logger type.
  registerProblemHandlers(app as unknown as FastifyInstance);
  app.get('/boom', () => Promise.reject(error));
  const res = await app.inject({ method: 'GET', url: '/boom' });
  await app.close();
  return { res, lines };
}

describe('problem handler logging', () => {
  it('logs load shedding as a cheap warning, without a stack trace (ADR-0093)', async () => {
    const { res, lines } = await serverThatThrows(new OverloadedError('overloaded', 5));
    expect(res.statusCode).toBe(503);
    const line = lines.find((l) => l.msg === 'request shed');
    expect(line).toMatchObject({ level: 40, status: 503 });
    expect(line).not.toHaveProperty('err');
    expect(lines.some((l) => l.msg === 'request failed')).toBe(false);
  });

  it('answers 503 + Retry-After, not 500, when the DB pool is saturated (ADR-0093)', async () => {
    // The exact error node-postgres throws when no pooled connection frees up in time.
    const { res, lines } = await serverThatThrows(
      new Error('timeout exceeded when trying to connect'),
    );
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json().type).toMatch(/overloaded$/);
    expect(lines.find((l) => l.msg === 'request shed')).toMatchObject({ level: 40 });
  });

  it('still logs unexpected failures as errors with the stack', async () => {
    const { res, lines } = await serverThatThrows(new Error('database exploded'));
    expect(res.statusCode).toBe(500);
    const line = lines.find((l) => l.msg === 'request failed');
    expect(line).toMatchObject({ level: 50 });
    expect((line?.err as { stack?: string } | undefined)?.stack).toContain('database exploded');
  });
});
