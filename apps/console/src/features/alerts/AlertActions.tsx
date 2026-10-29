import {
  ALERT_STATUS_TRANSITIONS,
  type AlertStatus,
  type AlertSummary,
} from '@spine/shared-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Select, useToast } from '../../components';
import { describeError, isApiError, queryKeys, useApi } from '../../lib/api';
import { useAuth, useCan } from '../../lib/auth/AuthProvider';
import { humanize } from '../../lib/format';

/** The statuses an alert may move to next (the state machine in the contract). */
export function allowedTransitions(status: AlertStatus): readonly AlertStatus[] {
  return ALERT_STATUS_TRANSITIONS[status];
}

function StatusChanger({ alert }: { alert: AlertSummary }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const options = allowedTransitions(alert.status);
  const [target, setTarget] = useState<AlertStatus | ''>(options[0] ?? '');
  const mutation = useMutation({
    mutationFn: (status: AlertStatus) => api.alerts.update(alert.id, { status }),
    onSuccess: (updated) => {
      toast.show(`Status changed to ${humanize(updated.status)}.`, 'success');
      setTarget(allowedTransitions(updated.status)[0] ?? '');
    },
    onError: (error) => {
      toast.show(
        isApiError(error, 409)
          ? `Someone changed this alert first: ${describeError(error)}`
          : describeError(error),
        'error',
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.alerts }),
  });
  return (
    <form
      className="sp-row"
      aria-label="Change status"
      onSubmit={(event) => {
        event.preventDefault();
        if (target) mutation.mutate(target);
      }}
    >
      <Select
        label="Move to status"
        value={target}
        options={options.map((s) => ({ value: s, label: humanize(s) }))}
        onChange={(event) => setTarget(event.target.value as AlertStatus)}
      />
      <Button type="submit" variant="primary" busy={mutation.isPending} disabled={!target}>
        Change status
      </Button>
    </form>
  );
}

function StartRun({ alertId }: { alertId: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const toast = useToast();
  const playbooks = useQuery({
    queryKey: queryKeys.playbooks,
    queryFn: () => api.playbooks.list(),
  });
  const [playbookId, setPlaybookId] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const options = playbooks.data ?? [];
  const selected = playbookId || options[0]?.id || '';
  const mutation = useMutation({
    mutationFn: () => api.playbooks.startRun(selected, alertId, dryRun),
    onSuccess: ({ runId }) => {
      toast.show(dryRun ? 'Dry run started.' : 'Playbook run started.', 'success');
      void navigate(`/runs/${runId}`);
    },
    onError: (error) => toast.show(describeError(error), 'error'),
  });
  return (
    <form
      className="sp-row"
      aria-label="Start a playbook run"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected) mutation.mutate();
      }}
    >
      <Select
        label="Playbook"
        value={selected}
        disabled={options.length === 0}
        options={
          options.length === 0
            ? [{ value: '', label: playbooks.isPending ? 'Loading…' : 'No playbooks' }]
            : options.map((p) => ({
                value: p.id,
                label: `${p.name}${p.enabled ? '' : ' (disabled)'}`,
              }))
        }
        onChange={(event) => setPlaybookId(event.target.value)}
      />
      <label className="sp-checkbox">
        <input
          type="checkbox"
          checked={dryRun}
          onChange={(event) => setDryRun(event.target.checked)}
        />
        Dry run (simulate, change nothing)
      </label>
      <Button type="submit" busy={mutation.isPending} disabled={!selected}>
        Start run
      </Button>
    </form>
  );
}

/**
 * Analyst actions on an alert. Rendered only for analysts and admins (`useCan`); the
 * server enforces the same rule, so hiding is a convenience, not the control (ADR-0017).
 */
export function AlertActions({ alert }: { alert: AlertSummary }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const canAct = useCan('analyst');
  const assign = useMutation({
    mutationFn: (assigneeId: string | null) => api.alerts.update(alert.id, { assigneeId }),
    onSuccess: (updated) =>
      toast.show(updated.assigneeId ? 'Assigned to you.' : 'Unassigned.', 'success'),
    onError: (error) => toast.show(describeError(error), 'error'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.alerts }),
  });
  const enrich = useMutation({
    mutationFn: () => api.alerts.enrich(alert.id),
    onSuccess: () =>
      toast.show('Re-enrichment requested. Results appear when providers answer.', 'success'),
    onError: (error) => toast.show(describeError(error), 'error'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.alert(alert.id) }),
  });

  if (!canAct || !user) {
    return <p className="sp-muted">You have read-only access. Analysts can triage and respond.</p>;
  }
  const mine = alert.assigneeId === user.id;
  return (
    <div className="sp-filters">
      <StatusChanger key={alert.status} alert={alert} />
      <div className="sp-row">
        <Button busy={assign.isPending} onClick={() => assign.mutate(mine ? null : user.id)}>
          {mine ? 'Unassign me' : 'Assign to me'}
        </Button>
        <Button busy={enrich.isPending} onClick={() => enrich.mutate()}>
          Re-run enrichment
        </Button>
      </div>
      <StartRun alertId={alert.id} />
    </div>
  );
}
