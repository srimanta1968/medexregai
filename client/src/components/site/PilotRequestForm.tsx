import { FormEvent, useState } from 'react';
import { ApiError, apiRequest } from '../../lib/api';
import { Field, FormMessage, SubmitButton } from '../auth/AuthUi';

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 4000;

type Errors = Partial<Record<'name' | 'workEmail' | 'firmName' | 'role' | 'message', string>>;

function validate(values: Record<string, string>): Errors {
  const errors: Errors = {};
  if (!values.name.trim()) errors.name = 'Please enter your name.';
  if (!values.workEmail.trim()) errors.workEmail = 'Please enter your work email.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.workEmail.trim())) errors.workEmail = 'Please enter a valid email address.';
  if (!values.firmName.trim()) errors.firmName = 'Please enter your firm name.';
  if (values.message.trim().length < MESSAGE_MIN) errors.message = `Please tell us a little more (at least ${MESSAGE_MIN} characters).`;
  return errors;
}

/** "Request a pilot": validated in the browser, then POST /api/pilot-requests. */
export default function PilotRequestForm(): JSX.Element {
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [sent, setSent] = useState<boolean>(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const read = (k: string): string => (typeof data.get(k) === 'string' ? (data.get(k) as string) : '');
    const values = { name: read('name'), workEmail: read('workEmail'), firmName: read('firmName'), role: read('role'), message: read('message') };
    const found = validate(values);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) {
      const first = Object.keys(found)[0];
      document.getElementById(first)?.focus();
      return;
    }
    setBusy(true);
    try {
      await apiRequest('/api/pilot-requests', {
        method: 'POST',
        body: { ...values, role: values.role.trim() || undefined, website: read('website') },
      });
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError && err.details) {
        setErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])) as Errors);
      } else {
        setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <FormMessage tone="success">
        <strong className="block">Thank you, your pilot request has been received.</strong>
        We will be in touch to arrange a short call.
      </FormMessage>
    );
  }

  return (
    <form className="space-y-5" onSubmit={onSubmit} noValidate aria-label="Request a pilot">
      {formError && <FormMessage tone="error">{formError}</FormMessage>}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field name="name" label="Your name" autoComplete="name" required error={errors.name} />
        <Field name="workEmail" label="Work email" type="email" autoComplete="email" required error={errors.workEmail} />
        <Field name="firmName" label="Firm" autoComplete="organization" required error={errors.firmName} />
        <Field name="role" label="Your role (optional)" autoComplete="organization-title" error={errors.role} />
      </div>
      <div>
        <label htmlFor="message" className="block text-sm font-medium text-slate-800">
          What would you like to try?
        </label>
        <textarea
          id="message"
          name="message"
          rows={5}
          maxLength={MESSAGE_MAX}
          required
          aria-invalid={errors.message ? true : undefined}
          aria-describedby={errors.message ? 'message-error' : 'message-hint'}
          className={`mt-1 block w-full rounded-md border px-3 py-2 text-slate-900 shadow-sm focus:border-brand-600 ${
            errors.message ? 'border-red-500' : 'border-slate-300'
          }`}
        />
        {errors.message ? (
          <p id="message-error" className="mt-1 text-sm text-red-700">
            {errors.message}
          </p>
        ) : (
          <p id="message-hint" className="mt-1 text-xs text-slate-500">
            For example, how many 510(k)s you have coming up and which device types.
          </p>
        )}
      </div>
      {/* Honeypot: off-screen and hidden from assistive technology; people never fill it. */}
      <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <div className="sm:w-56">
        <SubmitButton busy={busy}>Send pilot request</SubmitButton>
      </div>
      <p className="text-xs text-slate-500">We use these details only to contact you about the pilot.</p>
    </form>
  );
}
