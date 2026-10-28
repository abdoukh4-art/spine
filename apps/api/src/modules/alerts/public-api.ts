import type { Alert, AlertStatus } from '@spine/shared-schema';

/** Public API of the Alerts/Cases module. Other modules may import ONLY this file. */
export interface AlertsPublicApi {
  /** Returns the canonical alert snapshot, or null when unknown. */
  get(alertId: string): Promise<Alert | null>;
  /**
   * Changes an alert's status on behalf of an actor (a user, or `null` for automation such
   * as a playbook `set_status` step). Validates the transition and emits `alert.status_changed`.
   * @throws ConflictError on an illegal transition.
   */
  setStatus(alertId: string, to: AlertStatus, actorId: string | null): Promise<void>;
}
