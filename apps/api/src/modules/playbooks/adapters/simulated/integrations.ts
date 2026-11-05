import type { Indicator } from '@spine/shared-schema';
import type { Clock } from '../../../../platform/runtime.js';
import type {
  ChatPort,
  FirewallPort,
  ResponseActions,
  StatusPreviewPort,
  TicketingPort,
} from '../../application/ports.js';
import { stableId, type SimulatedActionRecorder } from './recorder.js';

/**
 * Simulated integrations (ADR-0018). They never touch a network: every "effect" is a row
 * in `simulated_actions`, shown in the console's Simulated integrations page. They behave
 * like good real APIs: idempotent per key, deterministic IDs, configurable latency/failures.
 * Code review rule: an adapter that performs real network I/O is rejected in this repo.
 */
export function createSimulatedIntegrations(
  recorder: SimulatedActionRecorder,
  clock: Clock,
): ResponseActions {
  const firewall: FirewallPort = {
    async block(request, options) {
      const expiresAt = new Date(
        clock.now().getTime() + request.durationMinutes * 60_000,
      ).toISOString();
      const response = await recorder.perform('firewall.block', options, request, () => ({
        blockId: stableId('FW', options.idempotencyKey),
        blocked: request.indicators,
        expiresAt,
      }));
      return {
        blockId: String(response.blockId),
        blocked: (response.blocked ?? []) as Indicator[],
        expiresAt: String(response.expiresAt),
      };
    },
    async unblock(request, options) {
      const response = await recorder.perform('firewall.unblock', options, request, () => ({
        blockId: request.blockId,
        unblocked: request.indicators,
      }));
      return {
        blockId: String(response.blockId),
        unblocked: (response.unblocked ?? []) as Indicator[],
      };
    },
  };

  const ticketing: TicketingPort = {
    async create(request, options) {
      const response = await recorder.perform('ticket.create', options, request, async () => ({
        ticketId: options.dryRun
          ? stableId('SIM-DRY', options.idempotencyKey)
          : `SIM-${await recorder.nextTicketNumber()}`,
      }));
      return { ticketId: String(response.ticketId) };
    },
    async close(request, options) {
      const response = await recorder.perform('ticket.close', options, request, () => ({
        ticketId: request.ticketId,
        closed: true,
      }));
      return { ticketId: String(response.ticketId), closed: response.closed === true };
    },
  };

  const chat: ChatPort = {
    async post(request, options) {
      const response = await recorder.perform('chat.post', options, request, () => ({
        messageId: stableId('MSG', options.idempotencyKey),
      }));
      return { messageId: String(response.messageId) };
    },
  };

  const statusPreview: StatusPreviewPort = {
    async record(request, options) {
      await recorder.perform('alert.set_status', options, request, () => ({ previewed: true }));
      return { previewed: true };
    },
  };

  return { firewall, ticketing, chat, statusPreview };
}
