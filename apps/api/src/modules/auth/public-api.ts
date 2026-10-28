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
  record(entry: AuditRecordInput): Promise<void>;
}

export interface AuthPublicApi {
  authenticator: Authenticator;
  audit: AuditRecorder;
}
