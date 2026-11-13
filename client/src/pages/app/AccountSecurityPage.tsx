import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';

interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  recoveryCodesLeft: number;
}

const input = 'mt-1 block w-40 rounded-md border border-slate-300 px-3 py-2 text-sm tracking-widest';
const primary = 'rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700';
const secondary = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * F4.4 two-step sign-in for the signed-in user (server: /api/auth/mfa*). Setup shows the key for an
 * authenticator app, a code confirms it, and ten recovery codes are shown once. Turning it off needs
 * a current code. Applies to password sign-in; provider sign-in uses the provider's own checks.
 */
export default function AccountSecurityPage(): JSX.Element {
  const { authedRequest } = useAuth();
  usePageMeta({ title: 'Sign-in security', description: 'Two-step sign-in with an authenticator app.' });
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    authedRequest<MfaStatus>('/api/auth/mfa')
      .then(setStatus)
      .catch((err: unknown) => setError(message(err, 'Could not load your sign-in settings.')));
  }, [authedRequest]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err, 'Something went wrong. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    act(async () => {
      setSetup(await authedRequest<{ secret: string; otpauthUrl: string }>('/api/auth/mfa/setup', { method: 'POST' }));
      setRecoveryCodes(null);
      setCode('');
    });

  const enable = () =>
    act(async () => {
      const r = await authedRequest<{ recoveryCodes: string[] }>('/api/auth/mfa/enable', { method: 'POST', body: { code } });
      setRecoveryCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      setNotice('Two-step sign-in is on.');
      load();
    });

  const disable = () =>
    act(async () => {
      await authedRequest('/api/auth/mfa/disable', { method: 'POST', body: { code } });
      setCode('');
      setRecoveryCodes(null);
      setNotice('Two-step sign-in is off.');
      load();
    });

  const codeField = (
    <label className="text-sm font-medium text-slate-900">
      Code from your app
      <input name="mfaCode" className={input} value={code} autoComplete="one-time-code" onChange={(e) => setCode(e.target.value)} />
    </label>
  );

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Sign-in security</h1>
      <p className="mt-1 text-sm text-slate-600">
        Two-step sign-in asks for a code from an authenticator app (such as Microsoft Authenticator, Google Authenticator or 1Password) after your password. It
        applies when you sign in with a password; signing in with Microsoft or Google uses their own checks.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      {status === null ? (
        <p role="status" className="mt-6 text-slate-500">
          Loading…
        </p>
      ) : (
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-slate-900">
            {status.enabled ? `Two-step sign-in is on · ${status.recoveryCodesLeft} recovery codes left` : 'Two-step sign-in is off'}
          </p>

          {recoveryCodes && (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">Recovery codes: save them now. They are shown only once, and each works once.</p>
              <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm text-slate-900 sm:grid-cols-5">
                {recoveryCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {!status.enabled && !setup && (
            <button type="button" className={`${primary} mt-4`} onClick={() => void start()}>
              Set up two-step sign-in
            </button>
          )}

          {!status.enabled && setup && (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-slate-700">
                In your authenticator app, add an account and enter this key (time-based, 6 digits), or open the setup link on this device.
              </p>
              <p className="break-all rounded-md bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900">{setup.secret}</p>
              <a className="text-sm font-semibold text-brand-700 hover:underline" href={setup.otpauthUrl}>
                Open in authenticator app
              </a>
              <div className="flex flex-wrap items-end gap-3">
                {codeField}
                <button type="button" className={primary} onClick={() => void enable()}>
                  Turn on
                </button>
              </div>
            </div>
          )}

          {status.enabled && (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              {codeField}
              <button type="button" className={secondary} onClick={() => void disable()}>
                Turn off two-step sign-in
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
