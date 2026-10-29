import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Badge, KeyValue, PageHeader, QueryView, Tabs } from '../../components';
import { queryKeys, useApi } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { conditionText, PlaybookFlow } from './PlaybookFlow';
import { ValidatePanel } from './ValidatePanel';

/** `/playbooks/:id`: metadata, the step flow, the YAML source and a validation sandbox. */
export default function PlaybookDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const query = useQuery({
    queryKey: queryKeys.playbook(id),
    queryFn: () => api.playbooks.get(id),
  });
  const record = query.data;
  return (
    <>
      <PageHeader
        title={record ? record.name : 'Playbook'}
        description={<Link to="/playbooks">← All playbooks</Link>}
      />
      <QueryView query={query} loadingLabel="Loading playbook">
        {(playbook) => {
          const { metadata, trigger } = playbook.definition;
          return (
            <>
              <section className="sp-section" aria-labelledby="pb-meta-h">
                <h2 id="pb-meta-h">About</h2>
                <KeyValue
                  items={[
                    { label: 'ID', value: <code>{playbook.id}</code> },
                    { label: 'Version', value: `v${String(playbook.version)}` },
                    {
                      label: 'State',
                      value: playbook.enabled ? (
                        <Badge tone="success">Enabled</Badge>
                      ) : (
                        <Badge>Disabled</Badge>
                      ),
                    },
                    { label: 'Description', value: metadata.description },
                    { label: 'Tags', value: metadata.tags.join(', ') },
                    {
                      label: 'Trigger',
                      value: trigger
                        ? `On ${trigger.event}${trigger.when ? ` when ${conditionText(trigger.when)}` : ''}`
                        : 'Manual only',
                    },
                    { label: 'Published', value: formatDateTime(playbook.createdAt) },
                  ]}
                />
              </section>
              <Tabs
                label="Playbook views"
                tabs={[
                  {
                    id: 'flow',
                    label: 'Flow',
                    content: <PlaybookFlow definition={playbook.definition} />,
                  },
                  {
                    id: 'source',
                    label: 'YAML source',
                    content: (
                      <pre className="sp-code" aria-label="Playbook source">
                        <code>{playbook.source}</code>
                      </pre>
                    ),
                  },
                  {
                    id: 'validate',
                    label: 'Validate',
                    content: <ValidatePanel initialSource={playbook.source} />,
                  },
                ]}
              />
            </>
          );
        }}
      </QueryView>
    </>
  );
}
