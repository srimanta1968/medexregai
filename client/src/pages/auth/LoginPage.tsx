import { FormEvent, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { AuthCard, Field, FormMessage, SubmitButton, TextLink } from '../../components/auth/AuthUi';
import { SSO_ERROR_MESSAGES, SsoButtons } from '../../components/auth/SsoButtons';
import { usePageMeta } from '../../hooks/usePageMeta';
import { formValue, useSubmit } from './useForm';

export default function LoginPage(): JSX.Element {
  usePageMeta({ title: 'Sign in', description: 'Sign in to your MedexRegAI firm workspace.' });
  const { login, verifyMfa } = useAuth();
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { busy, error, run } = useSubmit();
  const [params] = useSearchParams();
  const ssoError = params.get('sso_error');
  const from = (location.state as { from?: string } | null)?.from ?? '/app';

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const email = formValue(event, 'email');
    const password = formValue(event, 'password');
    return run(async () => {
      const challenge = await login(email, password);
      if (challenge) {
        setMfaToken(challenge.mfaToken);
        return;
      }
      navigate(from, { replace: true });
    })(event);
  };

  const onVerify = (event: FormEvent<HTMLFormElement>) => {
    const code = formValue(event, 'mfaCode');
    return run(async () => {
      await verifyMfa(mfaToken ?? '', code);
      navigate(from, { replace: true });
    })(event);
  };

  if (mfaToken) {
    return (
      <AuthCard title="Two-step sign-in" subtitle="Enter the 6-digit code from your authenticator app, or one of your recovery codes.">
        <form className="space-y-5" onSubmit={onVerify} noValidate>
          {error && <FormMessage tone="error">{error.message}</FormMessage>}
          <Field name="mfaCode" label="Code" autoComplete="one-time-code" inputMode="text" required />
          <SubmitButton busy={busy}>Verify</SubmitButton>
          <p className="text-sm text-slate-600">
            Code not working?{' '}
            <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => setMfaToken(null)}>
              Start again
            </button>
          </p>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Welcome back to your firm workspace."
      footer={
        <>
          New to MedexRegAI? <TextLink to="/signup">Create a firm workspace</TextLink>
        </>
      }
    >
      {ssoError && (
        <div className="mb-5">
          <FormMessage tone="error">{SSO_ERROR_MESSAGES[ssoError] ?? SSO_ERROR_MESSAGES.provider_error}</FormMessage>
        </div>
      )}
      <SsoButtons />
      <form className="mt-5 space-y-5" onSubmit={onSubmit} noValidate>
        {error && <FormMessage tone="error">{error.message}</FormMessage>}
        <Field name="email" label="Work email" type="email" autoComplete="email" required />
        <Field name="password" label="Password" type="password" autoComplete="current-password" required />
        <div className="text-right text-sm">
          <TextLink to="/forgot-password">Forgot your password?</TextLink>
        </div>
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
    </AuthCard>
  );
}
