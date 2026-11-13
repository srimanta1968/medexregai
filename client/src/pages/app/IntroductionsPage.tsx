import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { Introduction, introductionsApi, IntroSettings, Pathway, PATHWAYS, SPECIALTIES } from '../../lib/introductionsApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const chip = 'rounded-full border px-3 py-1 text-xs font-medium';
const primary = 'rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60';
const secondary = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const msg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/**
 * F6.2 introductions for consultants (UI 2.0 §8.2), owners and admins: opt in or out, choose the
 * FDA specialties and pathways the firm takes, and accept or decline introductions. A company's
 * name and contact appear only after the firm accepts.
 */
export default function IntroductionsPage(): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => introductionsApi(authedRequest), [authedRequest]);
  usePageMeta({ title: 'Introductions', description: 'Opt-in introductions from device companies.' });

  const [settings, setSettings] = useState<IntroSettings | null>(null);
  const [draft, setDraft] = useState<{ optedIn: boolean; specialties: string[]; pathways: Pathway[]; profile: string }>({ optedIn: false, specialties: [], pathways: [], profile: '' });
  const [items, setItems] = useState<Introduction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.settings(), api.list()])
      .then(([s, l]) => {
        setSettings(s);
        setDraft({ optedIn: s.optedIn, specialties: s.specialties, pathways: s.pathways, profile: s.profile ?? '' });
        setItems(l.items);
      })
      .catch((err: unknown) => setError(msg(err, 'Could not load introductions.')));
  }, [api]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(msg(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const save = (optedIn: boolean) =>
    run(async () => {
      const s = await api.saveSettings({ ...draft, optedIn, profile: draft.profile.trim() || null });
      setSettings(s);
      setDraft({ optedIn: s.optedIn, specialties: s.specialties, pathways: s.pathways, profile: s.profile ?? '' });
      setNotice(s.optedIn ? 'Your firm now receives introductions that match.' : 'Your firm no longer receives new introductions.');
    }, 'Could not save the settings.');

  const decide = (i: Introduction, decision: 'accept' | 'decline') =>
    run(async () => {
      const updated = await api.decide(i.id, decision);
      setItems((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)));
      setNotice(decision === 'accept' ? `Introduction accepted. ${updated.company?.name ?? 'The company'} has been told by email.` : 'Introduction declined.');
    }, 'Could not record your decision.');

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Introductions</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Device companies that ask to be introduced are shared only with firms that opted in and work in the device&apos;s FDA specialty and pathway. You see
        the company&apos;s description first; its name and contact appear when you accept.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      {settings && (
        <section className={`${card} mt-6`} aria-labelledby="optin-title">
          <h2 id="optin-title" className="text-lg font-semibold text-slate-900">
            Your firm: {settings.optedIn ? 'receiving introductions' : 'not receiving introductions'}
          </h2>
          <p className="mt-3 text-sm font-medium text-slate-900">FDA specialties you take (none chosen = any)</p>
          <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Specialties">
            {SPECIALTIES.map((s) => (
              <button
                key={s.code}
                type="button"
                aria-pressed={draft.specialties.includes(s.code)}
                className={`${chip} ${draft.specialties.includes(s.code) ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
                onClick={() => setDraft({ ...draft, specialties: toggle(draft.specialties, s.code) })}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-sm font-medium text-slate-900">Pathways you take (none chosen = any)</p>
          <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Pathways">
            {PATHWAYS.map((p) => (
              <button
                key={p.key}
                type="button"
                aria-pressed={draft.pathways.includes(p.key)}
                className={`${chip} ${draft.pathways.includes(p.key) ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
                onClick={() => setDraft({ ...draft, pathways: toggle(draft.pathways, p.key) })}
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="mt-3 block text-sm font-medium text-slate-900">
            About your firm (shown to a company after you accept)
            <textarea
              name="introProfile"
              rows={2}
              maxLength={1000}
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              value={draft.profile}
              onChange={(e) => setDraft({ ...draft, profile: e.target.value })}
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={primary} disabled={busy} onClick={() => void save(true)}>
              {settings.optedIn ? 'Save and keep receiving' : 'Opt in to introductions'}
            </button>
            {settings.optedIn && (
              <button type="button" className={secondary} disabled={busy} onClick={() => void save(false)}>
                Stop receiving introductions
              </button>
            )}
          </div>
        </section>
      )}

      {items && (
        <section className="mt-8" aria-labelledby="inbox-title">
          <h2 id="inbox-title" className="text-lg font-semibold text-slate-900">
            Introductions offered to your firm
          </h2>
          {items.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">None yet.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {items.map((i) => (
                <li key={i.id} className={card}>
                  <p className="text-sm text-slate-500">
                    {[i.specialtyLabel, i.productCode && `product code ${i.productCode}`, `pathway: ${i.pathwayLabel}`].filter(Boolean).join(' · ')} · offered{' '}
                    {new Date(i.offeredAt).toLocaleDateString()}
                  </p>
                  <p className="mt-1 text-slate-900">{i.brief}</p>
                  {i.status === 'offered' && (
                    <div className="mt-3 flex gap-2">
                      <button type="button" className={primary} disabled={busy} onClick={() => void decide(i, 'accept')}>
                        Accept introduction
                      </button>
                      <button type="button" className={secondary} disabled={busy} onClick={() => void decide(i, 'decline')}>
                        Decline
                      </button>
                    </div>
                  )}
                  {i.status === 'accepted' && i.company && (
                    <p className="mt-3 rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
                      Accepted: {i.company.name} · {i.company.contactName} ·{' '}
                      <a href={`mailto:${i.company.contactEmail}`} className="underline">
                        {i.company.contactEmail}
                      </a>
                    </p>
                  )}
                  {i.status === 'declined' && <p className="mt-3 text-sm text-slate-500">Declined.</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
