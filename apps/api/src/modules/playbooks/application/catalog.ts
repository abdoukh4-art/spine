import { parsePlaybook, type PlaybookFormat } from '@spine/playbook-engine';
import type { PlaybookDefinition, PlaybookRecord, PlaybookSummary } from '@spine/shared-schema';
import { ConflictError, NotFoundError, PlaybookInvalidError } from '../../../platform/errors.js';
import type { AuditGateway, PlaybooksStore } from './ports.js';

/** Who is acting, for audit entries. */
export interface Actor {
  id: string;
  requestId?: string;
}

/** A playbook source file to seed at startup. */
export interface PlaybookSource {
  name: string;
  source: string;
  format: PlaybookFormat;
}

/**
 * Playbook catalog use cases: list, read, validate, publish a new immutable version,
 * enable/disable, and seed versions shipped in `config/playbooks` (ADR-0013).
 */
export class PlaybookCatalog {
  constructor(
    private readonly store: PlaybooksStore,
    private readonly audit: AuditGateway,
  ) {}

  /** Latest version of each playbook. */
  list(): Promise<PlaybookSummary[]> {
    return this.store.playbooks.listLatest();
  }

  /** A specific (or the latest) version. @throws NotFoundError */
  async get(id: string, version?: number): Promise<PlaybookRecord> {
    const record = await this.store.playbooks.get(id, version);
    if (!record) throw new NotFoundError('Playbook', version ? `${id}@${version}` : id);
    return record;
  }

  /** Parses and validates source text. @throws PlaybookInvalidError with every problem. */
  validate(source: string, format: PlaybookFormat): PlaybookDefinition {
    const result = parsePlaybook(source, format);
    if (!result.valid) {
      throw new PlaybookInvalidError('The playbook is invalid', result.errors);
    }
    return result.definition;
  }

  /**
   * Publishes a new immutable version. `metadata.version` must be greater than every
   * stored version, so the source text and the stored record always agree.
   * @throws PlaybookInvalidError | ConflictError
   */
  async publish(source: string, format: PlaybookFormat, actor: Actor): Promise<PlaybookRecord> {
    const definition = this.validate(source, format);
    const { id, version } = definition.metadata;
    const latest = await this.store.playbooks.latestVersion(id);
    if (latest !== null && version <= latest) {
      throw new ConflictError(
        `playbook ${id} already has version ${latest}; set metadata.version to ${latest + 1} or higher`,
      );
    }
    const previous = latest === null ? null : await this.store.playbooks.get(id, latest);
    const inserted = await this.store.playbooks.insertIfMissing({
      definition,
      source,
      enabled: previous?.enabled ?? true,
      createdBy: actor.id,
    });
    if (!inserted) throw new ConflictError(`playbook ${id} version ${version} already exists`);
    await this.audit.record({
      actorId: actor.id,
      actorType: 'user',
      action: 'playbook.published',
      targetType: 'playbook',
      targetId: `${id}@${version}`,
      ...(actor.requestId ? { requestId: actor.requestId } : {}),
    });
    return this.get(id, version);
  }

  /** Enables or disables automatic triggering. @throws NotFoundError */
  async setEnabled(id: string, enabled: boolean, actor: Actor): Promise<PlaybookSummary> {
    const summary = await this.store.playbooks.setEnabled(id, enabled);
    if (!summary) throw new NotFoundError('Playbook', id);
    await this.audit.record({
      actorId: actor.id,
      actorType: 'user',
      action: enabled ? 'playbook.enabled' : 'playbook.disabled',
      targetType: 'playbook',
      targetId: id,
      ...(actor.requestId ? { requestId: actor.requestId } : {}),
    });
    return summary;
  }

  /**
   * Inserts each source whose `(id, version)` is not stored yet. Invalid files are
   * reported, not fatal: one bad file must not keep the worker from starting.
   */
  async seed(
    sources: readonly PlaybookSource[],
  ): Promise<{ inserted: string[]; invalid: string[] }> {
    const inserted: string[] = [];
    const invalid: string[] = [];
    for (const file of sources) {
      const result = parsePlaybook(file.source, file.format);
      if (!result.valid) {
        invalid.push(
          `${file.name}: ${result.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
        );
        continue;
      }
      const ok = await this.store.playbooks.insertIfMissing({
        definition: result.definition,
        source: file.source,
        enabled: true,
        createdBy: null,
      });
      if (ok)
        inserted.push(`${result.definition.metadata.id}@${result.definition.metadata.version}`);
    }
    return { inserted, invalid };
  }
}
