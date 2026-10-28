import {
  APPROVAL_STATUSES,
  roleSatisfies,
  type Approval,
  type ApprovalStatus,
  type Page,
} from '@spine/shared-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Button,
  Dialog,
  EmptyState,
  PageHeader,
  QueryView,
  StatusBadge,
  Tabs,
  Textarea,
  cx,
  useToast,
} from '../../components';
import { describeError, isApiError, queryKeys, useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth/AuthProvider';
import { formatDateTime, formatDuration, humanize } from '../../lib/format';
import { useNow } from '../../lib/hooks';

type Decision = 'approve' | 'reject';

/** Countdown text for an approval's expiry, relative to `now` (epoch ms). */
export function expiryLabel(expiresAt: string, now: number): { text: string; urgent: boolean } {
  const seconds = (Date.parse(expiresAt) - now) / 1000;
  if (seconds <= 0) return { text: 'Expired', urgent: true };
  return { text: `Expires in ${formatDuration(seconds)}`, urgent: seconds < 5 * 60 };
}

/**
 * Optimistic approve/reject: the card disappears immediately; if the server answers 409
 * (someone else decided first, or it expired) the list is rolled back and refetched, and
 * a toast explains what happened.
 */
function useDecide() {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const listKey = queryKeys.approvalList('pending');
  return useMutation({
    mutationFn: (v: { approval: Approval; decision: Decision; comment: string }) =>
      api.approvals.decide(v.approval.id, {
        decision: v.decision,
        ...(v.comment.trim() ? { comment: v.comment.trim() } : {}),
      }),
    onMutate: async ({ approval }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<Page<Approval>>(listKey);
      queryClient.setQueryData<Page<Approval>>(listKey, (old) =>
        old ? { ...old, items: old.items.filter((a) => a.id !== approval.id) } : old,
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(listKey, context.previous);
      toast.show(
        isApiError(error, 409)
          ? 'This approval was already decided or has expired. The list has been refreshed.'
          : describeError(error),
        'error',
      );
    },
    onSuccess: (approval) =>
      toast.show(
        approval.status === 'approved'
          ? 'Approved. The run continues.'
          : 'Rejected. The run takes its rejection path.',
        'success',
      ),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs });
    },
  });
}

function ApprovalCard({
  approval,
  now,
  onDecide,
}: {
  approval: Approval;
  now: number;
  onDecide: (approval: Approval, decision: Decision) => void;
}) {
  const { user } = useAuth();
  const expiry = expiryLabel(approval.expiresAt, now);
  const canDecide =
    approval.status === 'pending' &&
    !expiry.text.startsWith('Expired') &&
    user !== null &&
    roleSatisfies(user.role, approval.approverRole);
  const headingId = `approval-${approval.id}`;
  return (
    <li className="sp-card" aria-labelledby={headingId}>
      <h2 id={headingId} className="sp-card__title">
        {approval.prompt}
      </h2>
      <p className="sp-small">
        <StatusBadge status={approval.status} /> Playbook{' '}
        <Link to={`/playbooks/${approval.playbookId}`}>{approval.playbookId}</Link>, step{' '}
        <code>{approval.stepId}</code> · <Link to={`/alerts/${approval.alertId}`}>View alert</Link>{' '}
        · <Link to={`/runs/${approval.runId}`}>View run</Link>
      </p>
      <p className="sp-small sp-muted">
        Requested {formatDateTime(approval.requestedAt)} · needs role {approval.approverRole}
      </p>
      {approval.status === 'pending' ? (
        <p className={cx('sp-small', expiry.urgent && 'sp-countdown--urgent')}>
          <time dateTime={approval.expiresAt}>{expiry.text}</time>
          {expiry.urgent && expiry.text !== 'Expired' ? ' (soon)' : ''}
        </p>
      ) : (
        <p className="sp-small">
          {humanize(approval.status)} {approval.decidedAt ? formatDateTime(approval.decidedAt) : ''}
          {approval.comment ? ` · “${approval.comment}”` : ''}
        </p>
      )}
      {canDecide ? (
        <div className="sp-card__actions">
          <Button variant="primary" onClick={() => onDecide(approval, 'approve')}>
            Approve
          </Button>
          <Button variant="danger" onClick={() => onDecide(approval, 'reject')}>
            Reject
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function DecisionDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: { approval: Approval; decision: Decision } | null;
  onCancel: () => void;
  onConfirm: (comment: string) => void;
}) {
  const [comment, setComment] = useState('');
  const approve = pending?.decision === 'approve';
  const close = () => {
    setComment('');
    onCancel();
  };
  return (
    <Dialog
      open={pending !== null}
      onClose={close}
      title={approve ? 'Approve this action?' : 'Reject this action?'}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant={approve ? 'primary' : 'danger'}
            onClick={() => {
              const text = comment;
              setComment('');
              onConfirm(text);
            }}
          >
            {approve ? 'Confirm approval' : 'Confirm rejection'}
          </Button>
        </>
      }
    >
      <p>{pending?.approval.prompt}</p>
      <Textarea
        label="Comment (optional)"
        hint="Recorded in the audit log with your decision."
        maxLength={2000}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
    </Dialog>
  );
}

function ApprovalList({ status }: { status: ApprovalStatus }) {
  const api = useApi();
  const now = useNow(1000);
  const decide = useDecide();
  const [pending, setPending] = useState<{ approval: Approval; decision: Decision } | null>(null);
  const query = useQuery({
    queryKey: queryKeys.approvalList(status),
    queryFn: () => api.approvals.list({ status, limit: 100 }),
    refetchInterval: status === 'pending' ? 10_000 : false,
  });
  return (
    <>
      <QueryView
        query={query}
        loadingLabel="Loading approvals"
        isEmpty={(page) => page.items.length === 0}
        empty={
          <EmptyState
            title={status === 'pending' ? 'No approvals waiting. Nice.' : `No ${status} approvals.`}
          />
        }
      >
        {(page) => (
          <ul className="sp-cards" aria-label={`${humanize(status)} approvals`}>
            {page.items.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                now={now}
                onDecide={(a, decision) => setPending({ approval: a, decision })}
              />
            ))}
          </ul>
        )}
      </QueryView>
      <DecisionDialog
        pending={pending}
        onCancel={() => setPending(null)}
        onConfirm={(comment) => {
          if (pending) decide.mutate({ ...pending, comment });
          setPending(null);
        }}
      />
    </>
  );
}

/** `/approvals`: the human gates playbooks are waiting on (ADR-0013 approval steps). */
export default function ApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('status');
  const status: ApprovalStatus = APPROVAL_STATUSES.find((s) => s === raw) ?? 'pending';
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Playbook steps that wait for a human decision before acting."
      />
      <Tabs
        label="Approval status"
        selectedId={status}
        onSelect={(id) => setParams(id === 'pending' ? {} : { status: id }, { replace: true })}
        tabs={APPROVAL_STATUSES.map((s) => ({
          id: s,
          label: humanize(s),
          content: s === status ? <ApprovalList status={s} /> : null,
        }))}
      />
    </>
  );
}
