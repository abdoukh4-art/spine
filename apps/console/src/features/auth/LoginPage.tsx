import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Button, Callout, ErrorState, TextInput } from '../../components';
import { describeError, isApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth/AuthProvider';
import { safeNextPath } from '../../lib/auth/guards';
import { useDocumentTitle } from '../../lib/hooks';

/**
 * Login form. On a 401 it shows one generic message ("email or password is incorrect"),
 * never which of the two was wrong (no account enumeration, OWASP ASVS V2).
 */
export default function LoginPage() {
  useDocumentTitle('Log in');
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNextPath(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated') return <Navigate to={next} replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const errors: { email?: string; password?: string } = {};
    if (!email.trim()) errors.email = 'Enter your email address.';
    if (!password) errors.password = 'Enter your password.';
    setFieldErrors(errors);
    setFormError(null);
    if (errors.email || errors.password) return;
    setBusy(true);
    try {
      await login(email.trim(), password);
      void navigate(next, { replace: true });
    } catch (error) {
      setFormError(
        isApiError(error, 401)
          ? 'Email or password is incorrect.'
          : isApiError(error, 429)
            ? 'Too many attempts. Wait a minute and try again.'
            : describeError(error),
      );
      setBusy(false);
    }
  };

  return (
    <main id="main" className="sp-main sp-login">
      <div className="sp-section" style={{ maxWidth: 420, margin: '10vh auto 0' }}>
        <h1 className="sp-page-header__title">Log in to Spine</h1>
        <p className="sp-muted">SOAR console</p>
        {formError ? <ErrorState title="Login failed" message={formError} /> : null}
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="sp-filters">
          <TextInput
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={fieldErrors.email}
          />
          <TextInput
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={fieldErrors.password}
          />
          <Button type="submit" variant="primary" busy={busy}>
            Log in
          </Button>
        </form>
        {import.meta.env.VITE_USE_FAKE_API === 'true' ? (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Callout title="Demo mode (fake API)">
              <p>
                Accounts: <code>ada@spine.local</code> (admin), <code>sam@spine.local</code>{' '}
                (analyst), <code>val@spine.local</code> (viewer). Password:{' '}
                <code>spine-demo-password</code>.
              </p>
            </Callout>
          </div>
        ) : null}
      </div>
    </main>
  );
}
