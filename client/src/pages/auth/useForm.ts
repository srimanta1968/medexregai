import { FormEvent, useState } from 'react';
import { ApiError } from '../../lib/api';

/** Submit state shared by the auth forms: busy flag, form-level error, per-field errors from the API. */
export function useSubmit() {
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = (work: () => Promise<void>) => async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, run, fieldError: (field: string) => error?.fieldError(field) };
}

export function formValue(event: FormEvent<HTMLFormElement>, name: string): string {
  const value = new FormData(event.currentTarget).get(name);
  return typeof value === 'string' ? value : '';
}
