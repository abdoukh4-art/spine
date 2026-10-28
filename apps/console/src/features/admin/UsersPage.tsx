import { CreateUserRequestSchema, ROLES, type Role, type User } from '@spine/shared-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  PageHeader,
  QueryView,
  Select,
  Table,
  TextInput,
  useToast,
} from '../../components';
import { describeError, isApiError, queryKeys, useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth/AuthProvider';
import { formatDateTime, humanize } from '../../lib/format';

const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: humanize(r) }));

type FormFields = 'email' | 'displayName' | 'role' | 'password';
const EMPTY_FORM: Record<FormFields, string> = {
  email: '',
  displayName: '',
  role: 'viewer',
  password: '',
};

/** Maps validation issues (client- or server-side) onto form fields by their first path segment. */
export function fieldErrorsFrom(
  issues: readonly { path: string; message: string }[],
): Partial<Record<FormFields, string>> {
  const result: Partial<Record<FormFields, string>> = {};
  for (const issue of issues) {
    const field = issue.path.split('.')[0] as FormFields;
    if (field in EMPTY_FORM && !result[field]) result[field] = issue.message;
  }
  return result;
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<FormFields, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const close = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    setFormError(null);
    onClose();
  };
  const mutation = useMutation({
    mutationFn: () => api.users.create(CreateUserRequestSchema.parse(form)),
    onSuccess: (user) => {
      toast.show(`Created ${user.displayName}.`, 'success');
      void queryClient.invalidateQueries({ queryKey: queryKeys.users });
      close();
    },
    onError: (error) => {
      if (isApiError(error) && error.errors.length > 0) setErrors(fieldErrorsFrom(error.errors));
      setFormError(describeError(error));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = CreateUserRequestSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(
        fieldErrorsFrom(
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
      return;
    }
    setErrors({});
    setFormError(null);
    mutation.mutate();
  };
  const set = (field: FormFields) => (value: string) => setForm((f) => ({ ...f, [field]: value }));
  return (
    <Dialog open={open} onClose={close} title="Create a user">
      <form noValidate onSubmit={submit} className="sp-filters" aria-label="New user">
        {formError ? <ErrorState title="Could not create the user" message={formError} /> : null}
        <TextInput
          label="Email"
          type="email"
          autoComplete="off"
          value={form.email}
          error={errors.email}
          onChange={(e) => set('email')(e.target.value)}
        />
        <TextInput
          label="Display name"
          value={form.displayName}
          error={errors.displayName}
          onChange={(e) => set('displayName')(e.target.value)}
        />
        <Select
          label="Role"
          options={ROLE_OPTIONS}
          value={form.role}
          error={errors.role}
          onChange={(e) => set('role')(e.target.value)}
        />
        <TextInput
          label="Initial password"
          hint="12–128 characters. Share it securely; the user should change it."
          type="password"
          autoComplete="new-password"
          value={form.password}
          error={errors.password}
          onChange={(e) => set('password')(e.target.value)}
        />
        <div className="sp-row">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" busy={mutation.isPending}>
            Create user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function UserRow({ user, isSelf }: { user: User; isSelf: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const update = useMutation({
    mutationFn: (body: { role?: Role; disabled?: boolean }) => api.users.update(user.id, body),
    onSuccess: (u) =>
      toast.show(`${u.displayName}: ${u.disabled ? 'disabled' : humanize(u.role)}.`, 'success'),
    onError: (error) => toast.show(describeError(error), 'error'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  });
  return (
    <tr>
      <th scope="row" style={{ fontWeight: 'normal' }}>
        {user.displayName} {isSelf ? <span className="sp-muted">(you)</span> : null}
      </th>
      <td>{user.email}</td>
      <td>
        {isSelf ? (
          humanize(user.role)
        ) : (
          <Select
            label={`Role of ${user.displayName}`}
            labelHidden
            options={ROLE_OPTIONS}
            value={user.role}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ role: e.target.value as Role })}
          />
        )}
      </td>
      <td>
        {user.disabled ? (
          <Badge tone="danger">Disabled</Badge>
        ) : (
          <Badge tone="success">Active</Badge>
        )}
      </td>
      <td>{formatDateTime(user.lastLoginAt)}</td>
      <td>
        {isSelf ? null : (
          <Button
            size="sm"
            variant={user.disabled ? 'secondary' : 'danger'}
            busy={update.isPending}
            onClick={() => update.mutate({ disabled: !user.disabled })}
          >
            {user.disabled ? 'Enable' : 'Disable'}
            <span className="visually-hidden"> {user.displayName}</span>
          </Button>
        )}
      </td>
    </tr>
  );
}

/** `/admin/users`: list, create, change role, disable (admin only, also enforced server-side). */
export default function UsersPage() {
  const api = useApi();
  const { user: me } = useAuth();
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.users,
    queryFn: () => api.users.list({ limit: 200 }),
  });
  return (
    <>
      <PageHeader
        title="Users"
        description="Roles: viewer (read-only) < analyst (triage, approve, run) < admin (playbooks, users, audit)."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New user
          </Button>
        }
      />
      <QueryView query={query} loadingLabel="Loading users">
        {(page) => (
          <Table caption="Users" captionHidden>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">State</th>
                <th scope="col">Last login</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((u) => (
                <UserRow key={u.id} user={u} isSelf={u.id === me?.id} />
              ))}
            </tbody>
          </Table>
        )}
      </QueryView>
      <CreateUserDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
