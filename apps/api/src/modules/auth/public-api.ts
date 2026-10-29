import type { Db } from '../../platform/db/database.js';
import type { Authenticator } from '../../platform/http/access.js';

/**
 * Public API of the Auth module (ADR-0016, ADR-0017). Other modules may import ONLY this file.
 */
export interface AuditRecordInput {
  actorId: string | null;
  actorType: 'user' | 'system' | 'webhook' | 'anonymous';
  /** Dotted verb, e.g. `approval.decided`, `playbook.published`, `auth.token_reuse_detected`. */
  action: string;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

/** Writes explicit, domain-significant audit entries (in addition to the automatic HTTP audit hook). */
export interface AuditRecorder {
  /**
   * Appends one entry. Pass `executor` (your open transaction) to make the entry commit or
   * roll back together with your state change; this is the recommended use for decisions
   * such as approvals. Errors propagate to the caller (see ADR-0064).
   */
  record(entry: AuditRecordInput, executor?: Db): Promise<void>;
}

/** What the auth module offers other modules: request authentication and the audit recorder. */
export interface AuthPublicApi {
  authenticator: Authenticator;
  audit: AuditRecorder;
}
