import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Session, useAuth } from '../../auth/AuthContext';
import { AuthCard, Field, FormMessage, SubmitButton, TextLink } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError, apiRequest } from '../../lib/api';
import { formValue, useSubmit } from './useForm';

interface Preview {
  provider: string;
  email: string;
  fullName: string | null;
}

const PROVIDER_NAMES: Record<string, string> = { google: 'Google', microsoft: 'Microsoft' };

/**
 * After a Google/Microsoft sign-in for an email with no account: confirm the name and
 * name the firm. The one-time code arrives in the URL fragment (never sent to servers
 * or logs) and is kept in memory only.
 */
export default function SsoSignupPage(): JSX.Element {
  usePageMeta({ title: 'Create your firm workspace', description: 'Finish creating your MedexRegAI workspace.' });
  const { adopt } = useAuth();
  const navigate = useNavigate();
  const { busy, error, run, fieldError } = useSubmit();
  const code = useRef<string>('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!code.current) {
      code.current = new URLSearchParams(window.location.hash.slice(1)).get('code') ?? '';
      window.history.replaceState(null, '', window.location.pathname);
    }
    if (!code.current) {
      setLoadError('This sign-up link is incomplete. Please sign in with Google or Microsoft again.');
      return;
    }
    let active = true;
    apiRequest<Preview>('/api/auth/sso/signup/preview', { method: 'POST', body: { code: code.current } })
      .then((p) => {
        if (active) setPreview(p);
      })
      .catch((err: unknown) => {
        if (active) setLoadError(err instanceof ApiError ? err.message : 'Could not continue sign-up.');
      });
    return () => {
      active = false;
    };
  }, []);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const fullName = formValue(event, 'fullName');
    const firmName = formValue(event, 'firmName');
    return run(async () => {
      adopt(await apiRequest<Session>('/api/auth/sso/signup', { method: 'POST', body: { code: code.current, fullName, firmName } }));
      navigate('/app', { replace: true });
    })(event);
  };

  if (loadError) {
    return (
      <AuthCard title="Create your firm workspace" footer={<TextLink to="/login">Back to sign in</TextLink>}>
        <FormMessage tone="error">{loadError}</FormMessage>
      </AuthCard>
    );
  }
  if (!preview) {
    return (
      <AuthCard title="Create your firm workspace">
        <p role="status" className="text-slate-500">
          Loading…
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard
      title="Create your firm workspace"
      subtitle={
        <>
          Signed in with {PROVIDER_NAMES[preview.provider] ?? preview.provider} as <strong>{preview.email}</strong>. You will be the owner and can invite
          your team afterwards.
        </>
      }
    >
      <form className="space-y-5" onSubmit={onSubmit} noValidate>
        {error && !error.details && <FormMessage tone="error">{error.message}</FormMessage>}
        <Field name="fullName" label="Your full name" autoComplete="name" required defaultValue={preview.fullName ?? ''} error={fieldError('fullName')} />
        <Field name="firmName" label="Firm name" autoComplete="organization" required error={fieldError('firmName')} />
        <SubmitButton busy={busy}>Create workspace</SubmitButton>
      </form>
    </AuthCard>
  );
}
