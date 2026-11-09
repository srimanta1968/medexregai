import { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { AuthCard, Field, FormMessage, SubmitButton, TextLink } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { formValue, useSubmit } from './useForm';

export default function SignUpPage(): JSX.Element {
  usePageMeta({ title: 'Create your firm workspace', description: 'Create a MedexRegAI workspace for your regulatory consulting firm.' });
  const { register } = useAuth();
  const navigate = useNavigate();
  const { busy, error, run, fieldError } = useSubmit();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const input = {
      fullName: formValue(event, 'fullName'),
      email: formValue(event, 'email'),
      password: formValue(event, 'password'),
      firmName: formValue(event, 'firmName'),
    };
    return run(async () => {
      await register(input);
      navigate('/app', { replace: true });
    })(event);
  };

  return (
    <AuthCard
      title="Create your firm workspace"
      subtitle="You will be the owner and can invite your team afterwards."
      footer={
        <>
          Already have an account? <TextLink to="/login">Sign in</TextLink>
        </>
      }
    >
      <form className="space-y-5" onSubmit={onSubmit} noValidate>
        {error && !error.details && <FormMessage tone="error">{error.message}</FormMessage>}
        <Field name="fullName" label="Your full name" autoComplete="name" required error={fieldError('fullName')} />
        <Field name="email" label="Work email" type="email" autoComplete="email" required error={fieldError('email')} />
        <Field
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          hint="At least 12 characters."
          error={fieldError('password')}
        />
        <Field name="firmName" label="Firm name" autoComplete="organization" required error={fieldError('firmName')} />
        <SubmitButton busy={busy}>Create workspace</SubmitButton>
      </form>
    </AuthCard>
  );
}
