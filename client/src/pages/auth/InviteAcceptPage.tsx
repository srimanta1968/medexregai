import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Session, useAuth } from '../../auth/AuthContext';
import { AuthCard, Field, FormMessage, SubmitButton, TextLink } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError, apiRequest } from '../../lib/api';
import { formValue, useSubmit } from './useForm';

interface InvitePreview {
  firmName: string;
  email: string;
  role: string;
  expiresAt: string;
  accountExists: boolean;
}

/** Field copy and browser autofill hint for someone with / without an account. */
const CREDENTIAL_FIELD = {
  existing: { label: 'Your MedexRegAI password', autofill: 'current-password', hint: undefined },
  new: { label: 'Choose a password', autofill: 'new-password', hint: 'At least 12 characters.' },
} as const;

export default function InviteAcceptPage(): JSX.Element {
  usePageMeta({ title: 'Accept your invitation', description: 'Join your firm workspace on MedexRegAI.' });
  const { token = '' } = useParams();
  const { adopt } = useAuth();
  const navigate = useNavigate();
  const { busy, error, run, fieldError } = useSubmit();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiRequest<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`)
      .then((p) => {
        if (active) setPreview(p);
      })
      .catch((err: unknown) => {
        if (active) setLoadError(err instanceof ApiError ? err.message : 'This invitation could not be loaded.');
      });
    return () => {
      active = false;
    };
  }, [token]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const password = formValue(event, 'password');
    const body = preview?.accountExists ? { password } : { fullName: formValue(event, 'fullName'), password };
    return run(async () => {
      adopt(await apiRequest<Session>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body }));
      navigate('/app', { replace: true });
    })(event);
  };

  if (loadError) {
    return (
      <AuthCard title="Invitation unavailable" footer={<TextLink to="/login">Go to sign in</TextLink>}>
        <FormMessage tone="error">{loadError}</FormMessage>
        <p className="mt-4 text-sm text-slate-600">Ask the person who invited you to send a new invitation.</p>
      </AuthCard>
    );
  }
  if (!preview) {
    return (
      <AuthCard title="Accept your invitation">
        <p role="status" className="text-slate-500">
          Loading invitation…
        </p>
      </AuthCard>
    );
  }

  const copy = CREDENTIAL_FIELD[preview.accountExists ? 'existing' : 'new'];
  return (
    <AuthCard
      title={`Join ${preview.firmName}`}
      subtitle={
        <>
          You have been invited as <strong className="capitalize">{preview.role}</strong> using {preview.email}.
        </>
      }
    >
      <form className="space-y-5" onSubmit={onSubmit} noValidate>
        {error && !error.details && <FormMessage tone="error">{error.message}</FormMessage>}
        {!preview.accountExists && <Field name="fullName" label="Your full name" autoComplete="name" required error={fieldError('fullName')} />}
        <Field
          name="password"
          label={copy.label}
          type="password"
          autoComplete={copy.autofill}
          required
          hint={copy.hint}
          error={fieldError('password')}
        />
        <SubmitButton busy={busy}>Accept invitation</SubmitButton>
      </form>
    </AuthCard>
  );
}
