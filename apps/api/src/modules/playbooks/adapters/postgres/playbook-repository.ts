import {
  PlaybookDefinitionSchema,
  type PlaybookDefinition,
  type PlaybookRecord,
  type PlaybookSummary,
} from '@spine/shared-schema';
import type { Selectable } from 'kysely';
import type { PlaybooksTable } from '../../../../platform/db/schema.js';
import type { NewPlaybookVersion, PlaybookRepository } from '../../application/ports.js';
import type { Executor } from './shared.js';

type Row = Selectable<PlaybooksTable>;

/** `playbooks` table: immutable `(id, version)` rows; `enabled` is read from the latest. */
export class PostgresPlaybookRepository implements PlaybookRepository {
  constructor(private readonly db: Executor) {}

  async listLatest(): Promise<PlaybookSummary[]> {
    const rows = await this.latestRows();
    return rows.map(toSummary);
  }

  async get(id: string, version?: number): Promise<PlaybookRecord | null> {
    let query = this.db.selectFrom('playbooks').selectAll().where('id', '=', id);
    if (version !== undefined) query = query.where('version', '=', version);
    const row = await query.orderBy('version', 'desc').limit(1).executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  async latestVersion(id: string): Promise<number | null> {
    const row = await this.db
      .selectFrom('playbooks')
      .select((eb) => eb.fn.max('version').as('v'))
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.v ?? null;
  }

  async insertIfMissing(version: NewPlaybookVersion): Promise<boolean> {
    const { id, version: v, name } = version.definition.metadata;
    const inserted = await this.db
      .insertInto('playbooks')
      .values({
        id,
        version: v,
        name,
        enabled: version.enabled,
        definition: JSON.stringify(version.definition),
        source: version.source,
        created_by: version.createdBy,
      })
      .onConflict((oc) => oc.columns(['id', 'version']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return inserted !== undefined;
  }

  async setEnabled(id: string, enabled: boolean): Promise<PlaybookSummary | null> {
    const latest = await this.latestVersion(id);
    if (latest === null) return null;
    await this.db
      .updateTable('playbooks')
      .set({ enabled })
      .where('id', '=', id)
      .where('version', '=', latest)
      .execute();
    const rows = await this.latestRows(id);
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async enabledLatest(): Promise<PlaybookDefinition[]> {
    const rows = await this.latestRows();
    return rows.filter((r) => r.enabled).map((r) => parseDefinition(r.definition));
  }

  private latestRows(id?: string): Promise<Row[]> {
    let query = this.db.selectFrom('playbooks').selectAll().distinctOn('id');
    if (id !== undefined) query = query.where('id', '=', id);
    return query.orderBy('id').orderBy('version', 'desc').execute();
  }
}

/** Stored definitions were validated on insert; parsing again guards against hand edits. */
function parseDefinition(value: unknown): PlaybookDefinition {
  return PlaybookDefinitionSchema.parse(value);
}

function toSummary(row: Row): PlaybookSummary {
  const definition = parseDefinition(row.definition);
  return {
    id: row.id,
    latestVersion: row.version,
    name: row.name,
    description: definition.metadata.description ?? null,
    enabled: row.enabled,
    stepCount: definition.steps.length,
    tags: definition.metadata.tags,
  };
}

function toRecord(row: Row): PlaybookRecord {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    enabled: row.enabled,
    definition: parseDefinition(row.definition),
    source: row.source,
    createdAt: row.created_at.toISOString(),
  };
}
