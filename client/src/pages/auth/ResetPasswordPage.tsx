import { FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AuthCard, Field, FormMessage, SubmitButton, TextLink } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { apiRequest } from '../../lib/api';
import { formValue, useSubmit } from './useForm';

export default function ResetPasswordPage(): JSX.Element {
  usePageMeta({ title: 'Choose a new password', description: 'Set a new password for your MedexRegAI account.' });
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { busy, error, run, fieldError } = useSubmit();
  const [done, setDone] = useState<boolean>(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const newPassword = formValue(event, 'newPassword');
    return run(async () => {
      await apiRequest('/api/auth/password-reset/confirm', { method: 'POST', body: { token, newPassword } });
      setDone(true);
    })(event);
  };

  if (!token) {
    return (
      <AuthCard title="Choose a new password" footer={<TextLink to="/forgot-password">Request a new link</TextLink>}>
        <FormMessage tone="error">This reset link is incomplete. Request a new one.</FormMessage>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" footer={<TextLink to="/login">Back to sign in</TextLink>}>
      {done ? (
        <FormMessage tone="success">Your password has been changed. You can now sign in with your new password.</FormMessage>
      ) : (
        <form className="space-y-5" onSubmit={onSubmit} noValidate>
          {error && !error.details && <FormMessage tone="error">{error.message}</FormMessage>}
          <Field
            name="newPassword"
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            hint="At least 12 characters."
            error={fieldError('newPassword')}
          />
          <SubmitButton busy={busy}>Change password</SubmitButton>
        </form>
      )}
    </AuthCard>
  );
}
