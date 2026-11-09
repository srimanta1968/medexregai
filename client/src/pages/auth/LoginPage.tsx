import { FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { AuthCard, Field, FormMessage, SubmitButton, TextLink } from '../../components/auth/AuthUi';
import { SSO_ERROR_MESSAGES, SsoButtons } from '../../components/auth/SsoButtons';
import { usePageMeta } from '../../hooks/usePageMeta';
import { formValue, useSubmit } from './useForm';

export default function LoginPage(): JSX.Element {
  usePageMeta({ title: 'Sign in', description: 'Sign in to your MedexRegAI firm workspace.' });
  const { login } = useAuth();
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
      await login(email, password);
      navigate(from, { replace: true });
    })(event);
  };

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
