import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { ApiKey, apiKeysApi, ApiScope, SCOPES } from '../../lib/apiKeysApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const chip = 'rounded-full border px-3 py-1 text-sm font-medium';
const primary = 'rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60';
const small = 'rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:border-red-400 disabled:opacity-60';
const msg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');

/**
 * F6.3 Billing and API (UI 2.0 §3). API keys: create a key with chosen read scopes (the secret is
 * shown once), see each key's scopes, last use and status, and revoke it. Plans and credits come
 * with the payment provider integration and are not available yet.
 */
export default function BillingApiPage(): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => apiKeysApi(authedRequest), [authedRequest]);
  usePageMeta({ title: 'Billing and API', description: 'API keys for the MedexRegAI public API.' });

  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [expiresInDays, setExpiresInDays] = useState('');
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .list()
      .then((r) => setKeys(r.items))
      .catch((err: unknown) => setError(msg(err, 'Could not load API keys.')));
  }, [api]);
  useEffect(load, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const days = expiresInDays.trim() ? Number(expiresInDays) : undefined;
      const out = await api.create({ name, scopes, ...(days ? { expiresInDays: days } : {}) });
      setSecret({ name: out.key.name, value: out.secret });
      setName('');
      setScopes([]);
      setExpiresInDays('');
      load();
    } catch (err) {
      setError(msg(err, 'Could not create the key.'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k: ApiKey) => {
    setBusy(true);
    setError(null);
    try {
      await api.revoke(k.id);
      setNotice(`Key "${k.name}" revoked. It stops working at once.`);
      if (secret?.name === k.name) setSecret(null);
      load();
    } catch (err) {
      setError(msg(err, 'Could not revoke the key.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Billing and API</h1>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      <section className={`${card} mt-6`} aria-labelledby="plans-title">
        <h2 id="plans-title" className="text-lg font-semibold text-slate-900">
          Plans and credits
        </h2>
        <p className="mt-1 text-sm text-slate-600">Self-serve plans and credits are not available yet. During the pilot, billing is agreed with us directly.</p>
      </section>

      <section className={`${card} mt-6`} aria-labelledby="keys-title">
        <h2 id="keys-title" className="text-lg font-semibold text-slate-900">
          API keys
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Keys give read access to the MedexRegAI API at <code>/api/v1</code> for the scopes you choose. Send a key as <code>Authorization: Bearer &lt;key&gt;</code>.
          Keys never work in the app itself. Revoke a key you no longer need.
        </p>

        {secret && (
          <div role="status" className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-semibold">Copy this key now. It will not be shown again.</p>
            <p className="mt-1 break-all font-mono text-xs">{secret.value}</p>
          </div>
        )}

        <form onSubmit={(e) => void create(e)} className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-slate-900">
            Key name
            <input name="keyName" maxLength={100} className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div role="group" aria-label="Scopes">
            <p className="text-sm font-medium text-slate-900">Access</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {SCOPES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={scopes.includes(s.key)}
                  className={`${chip} ${scopes.includes(s.key) ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
                  onClick={() => setScopes(scopes.includes(s.key) ? scopes.filter((x) => x !== s.key) : [...scopes, s.key])}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <label className="block text-sm font-medium text-slate-900">
            Expires after (days, optional)
            <input
              name="expiresInDays"
              type="number"
              min={1}
              max={730}
              className="mt-1 block w-40 rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />
          </label>
          <button type="submit" className={primary} disabled={busy}>
            Create key
          </button>
        </form>

        {keys && (
          <table className="mt-6 w-full text-left text-sm">
            <caption className="sr-only">Your API keys</caption>
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="pb-1 pr-3 font-medium">Name</th>
                <th scope="col" className="pb-1 pr-3 font-medium">Key</th>
                <th scope="col" className="pb-1 pr-3 font-medium">Access</th>
                <th scope="col" className="pb-1 pr-3 font-medium">Last used</th>
                <th scope="col" className="pb-1 pr-3 font-medium">Status</th>
                <th scope="col" className="pb-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-2 text-slate-600">
                    No API keys yet.
                  </td>
                </tr>
              )}
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-slate-100 align-top">
                  <td className="py-2 pr-3 text-slate-900">{k.name}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-slate-600">{k.prefix}…</td>
                  <td className="py-2 pr-3 text-slate-700">{k.scopes.map((s) => SCOPES.find((x) => x.key === s)?.label ?? s).join(', ')}</td>
                  <td className="py-2 pr-3 text-slate-600">{when(k.lastUsedAt)}</td>
                  <td className="py-2 pr-3 text-slate-700">
                    {k.status}
                    {k.expiresAt && k.status === 'active' ? ` until ${when(k.expiresAt)}` : ''}
                  </td>
                  <td className="py-2">
                    {k.status === 'active' && (
                      <button type="button" className={small} disabled={busy} onClick={() => void revoke(k)}>
                        Revoke {k.name}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
