import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Callout, ErrorState, Select, Textarea } from '../../components';
import { describeError, isApiError, useApi } from '../../lib/api';
import { useCan } from '../../lib/auth/AuthProvider';

/**
 * Paste a playbook and ask the server whether it's valid (`POST /playbooks/validate`).
 * A 422 lists every problem with its path, so authors can fix them all in one go.
 */
export function ValidatePanel({ initialSource }: { initialSource: string }) {
  const api = useApi();
  const canValidate = useCan('analyst');
  const [source, setSource] = useState(initialSource);
  const [format, setFormat] = useState<'yaml' | 'json'>('yaml');
  const mutation = useMutation({ mutationFn: () => api.playbooks.validate(source, format) });
  if (!canValidate) return <p className="sp-muted">Validating playbooks needs the analyst role.</p>;
  const error = mutation.error;
  return (
    <form
      className="sp-filters"
      aria-label="Validate a playbook"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <Select
        label="Format"
        value={format}
        options={[
          { value: 'yaml', label: 'YAML' },
          { value: 'json', label: 'JSON' },
        ]}
        onChange={(event) => setFormat(event.target.value as 'yaml' | 'json')}
      />
      <Textarea
        label="Playbook source"
        className="sp-field--code"
        spellCheck={false}
        value={source}
        onChange={(event) => setSource(event.target.value)}
        rows={16}
        style={{ fontFamily: 'var(--font-mono)', minHeight: 280 }}
      />
      <div>
        <Button type="submit" variant="primary" busy={mutation.isPending} disabled={!source.trim()}>
          Validate
        </Button>
      </div>
      {mutation.isSuccess ? (
        <div role="status">
          <Callout title="Valid playbook">
            <p>
              “{mutation.data.definition.metadata.name}” v
              {mutation.data.definition.metadata.version}: {mutation.data.definition.steps.length}{' '}
              steps, starting at <code>{mutation.data.definition.start}</code>.
            </p>
          </Callout>
        </div>
      ) : null}
      {error ? (
        isApiError(error) && error.errors.length > 0 ? (
          <div role="alert" className="sp-error">
            <p className="sp-error__title">
              {error.title}: {error.errors.length} problem{error.errors.length === 1 ? '' : 's'}
            </p>
            <ul>
              {error.errors.map((e) => (
                <li key={`${e.path}-${e.message}`}>
                  <code>{e.path}</code>: {e.message}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ErrorState title="Validation failed" message={describeError(error)} />
        )
      ) : null}
    </form>
  );
}
