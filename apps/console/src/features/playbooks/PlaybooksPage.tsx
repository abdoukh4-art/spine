import type { PlaybookSummary } from '@spine/shared-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Badge, EmptyState, PageHeader, QueryView, Table, useToast } from '../../components';
import { describeError, queryKeys, useApi } from '../../lib/api';
import { useCan } from '../../lib/auth/AuthProvider';

/** An accessible on/off switch (`role="switch"` + `aria-checked`) with a visible state label. */
function EnabledSwitch({ playbook }: { playbook: PlaybookSummary }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => api.playbooks.setEnabled(playbook.id, enabled),
    onSuccess: (updated) =>
      toast.show(`${updated.name} ${updated.enabled ? 'enabled' : 'disabled'}.`, 'success'),
    onError: (error) => toast.show(describeError(error), 'error'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.playbooks }),
  });
  const checked = mutation.isPending ? !playbook.enabled : playbook.enabled;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${playbook.name} enabled`}
      className="sp-switch"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(!playbook.enabled)}
    >
      <span className="sp-switch__track" aria-hidden="true" />
      <span aria-hidden="true">{checked ? 'On' : 'Off'}</span>
    </button>
  );
}

/** `/playbooks`: every playbook (latest version). Admins can enable/disable them. */
export default function PlaybooksPage() {
  const api = useApi();
  const isAdmin = useCan('admin');
  const query = useQuery({ queryKey: queryKeys.playbooks, queryFn: () => api.playbooks.list() });
  return (
    <>
      <PageHeader
        title="Playbooks"
        description="Versioned response workflows. Disabled playbooks never trigger automatically."
      />
      <QueryView
        query={query}
        loadingLabel="Loading playbooks"
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No playbooks published yet." />}
      >
        {(playbooks) => (
          <Table caption="Playbooks" captionHidden>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Description</th>
                <th scope="col">Version</th>
                <th scope="col" className="sp-num">
                  Steps
                </th>
                <th scope="col">Tags</th>
                <th scope="col">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {playbooks.map((p) => (
                <tr key={p.id}>
                  <th scope="row" style={{ fontWeight: 'normal' }}>
                    <Link to={`/playbooks/${p.id}`}>{p.name}</Link>
                    <div className="sp-muted sp-small sp-mono">{p.id}</div>
                  </th>
                  <td>{p.description ?? '—'}</td>
                  <td>v{p.latestVersion}</td>
                  <td className="sp-num">{p.stepCount}</td>
                  <td>{p.tags.join(', ') || '—'}</td>
                  <td>
                    {isAdmin ? (
                      <EnabledSwitch playbook={p} />
                    ) : p.enabled ? (
                      <Badge tone="success">Enabled</Badge>
                    ) : (
                      <Badge>Disabled</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </QueryView>
    </>
  );
}
