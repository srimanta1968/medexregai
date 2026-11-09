import { FormEvent, useState } from 'react';
import { AuthCard, Field, FormMessage, SubmitButton, TextLink } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { apiRequest } from '../../lib/api';
import { formValue, useSubmit } from './useForm';

export default function ForgotPasswordPage(): JSX.Element {
  usePageMeta({ title: 'Reset your password', description: 'Request a link to reset your MedexRegAI password.' });
  const { busy, error, run, fieldError } = useSubmit();
  const [sent, setSent] = useState<boolean>(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const email = formValue(event, 'email');
    return run(async () => {
      await apiRequest('/api/auth/password-reset/request', { method: 'POST', body: { email } });
      setSent(true);
    })(event);
  };

  return (
    <AuthCard
      title="Reset your password"
      subtitle="Enter your work email and we will send you a reset link."
      footer={<TextLink to="/login">Back to sign in</TextLink>}
    >
      {sent ? (
        <FormMessage tone="success">If an account exists for that email, a reset link is on its way. The link is valid for 60 minutes.</FormMessage>
      ) : (
        <form className="space-y-5" onSubmit={onSubmit} noValidate>
          {error && !error.details && <FormMessage tone="error">{error.message}</FormMessage>}
          <Field name="email" label="Work email" type="email" autoComplete="email" required error={fieldError('email')} />
          <SubmitButton busy={busy}>Send reset link</SubmitButton>
        </form>
      )}
    </AuthCard>
  );
}
