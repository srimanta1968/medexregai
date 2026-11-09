import { InputHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface AuthCardProps {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

/** Centered card used by every sign-in / sign-up style page. */
export function AuthCard({ title, subtitle, children, footer }: AuthCardProps): JSX.Element {
  return (
    <section className="flex flex-1 items-start justify-center bg-slate-50 px-4 py-16" aria-labelledby="auth-title">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 id="auth-title" className="text-2xl font-bold text-slate-900">
            {title}
          </h1>
          {subtitle && <p className="mt-2 text-sm text-slate-600">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
        {footer && <div className="mt-6 text-center text-sm text-slate-600">{footer}</div>}
      </div>
    </section>
  );
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Used for id and name, so tests and the API can address the field. */
  name: string;
  label: string;
  error?: string;
  hint?: string;
}

/** Labelled input with its error and hint wired up for screen readers. */
export function Field({ name, label, error, hint, ...input }: FieldProps): JSX.Element {
  const describedBy = [error ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={name}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`mt-1 block w-full rounded-md border px-3 py-2 text-slate-900 shadow-sm focus:border-brand-600 ${
          error ? 'border-red-500' : 'border-slate-300'
        }`}
        {...input}
      />
      {hint && !error && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export interface SubmitButtonProps {
  busy: boolean;
  children: ReactNode;
}

export function SubmitButton({ busy, children }: SubmitButtonProps): JSX.Element {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded-md bg-brand-600 px-4 py-2.5 font-semibold text-white hover:bg-brand-700 disabled:cursor-wait disabled:opacity-70"
    >
      {busy ? 'Please wait…' : children}
    </button>
  );
}

/** Form-level message (errors and confirmations), announced to screen readers. */
export function FormMessage({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }): JSX.Element {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-md px-4 py-3 text-sm ${tone === 'error' ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}
    >
      {children}
    </div>
  );
}

export function TextLink({ to, children }: { to: string; children: ReactNode }): JSX.Element {
  return (
    <Link to={to} className="font-semibold text-brand-700 hover:underline">
      {children}
    </Link>
  );
}
