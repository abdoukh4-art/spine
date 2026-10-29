import { writeFile } from 'node:fs/promises';
import { buildOpenApiServer } from '../openapi-server.js';

/**
 * Writes the OpenAPI document generated from the Zod route schemas (ADR-0005).
 * CI regenerates it and fails if the committed copy differs (contract-drift guard).
 */
const target = process.argv[2] ?? 'openapi.json';
const app = await buildOpenApiServer();
await app.ready();
await writeFile(target, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
process.stdout.write(`wrote ${target}\n`);
