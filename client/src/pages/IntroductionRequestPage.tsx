import { FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { usePageMeta } from '../hooks/usePageMeta';
import { ApiError } from '../lib/api';
import { PATHWAYS, RequestPathway, submitIntroductionRequest } from '../lib/introductionsApi';

const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const chip = 'rounded-full border px-3 py-1 text-sm font-medium';

/**
 * F6.2 public request (UI 2.0 §8.2): a device company asks to be introduced to a regulatory
 * consultant. Shared only with consultant firms that opted in and work in the device's FDA
 * specialty and pathway; a firm sees the company's details only if it accepts.
 */
export default function IntroductionRequestPage(): JSX.Element {
  usePageMeta({ title: 'Find a regulatory consultant', description: 'Ask to be introduced to a consultant firm that chose to take introductions.' });
  const [params] = useSearchParams();
  const [form, setForm] = useState({
    companyName: '',
    contactName: '',
    contactEmail: '',
    brief: '',
    productCode: (params.get('productCode') ?? '').toUpperCase().slice(0, 3),
    website: '',
  });
  const [pathway, setPathway] = useState<RequestPathway>('unsure');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await submitIntroductionRequest({
        companyName: form.companyName,
        contactName: form.contactName,
        contactEmail: form.contactEmail,
        brief: form.brief,
        productCode: form.productCode.trim() || undefined,
        pathway,
        consent,
        website: form.website || undefined,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your request could not be sent. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold text-slate-900">Find a regulatory consultant</h1>
      <p className="mt-2 text-slate-600">
        Tell us about your device. We share your request only with consultant firms that chose to receive introductions and work with devices like yours.
        They see your description first; your name and contact details go only to a firm that accepts, and you hear from them directly.
      </p>
      {done ? (
        <p role="status" className="mt-8 rounded-md bg-emerald-50 p-4 text-emerald-900">
          Thank you. Your request has been shared with matching consultant firms. If a firm accepts, it will contact you by email.
        </p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="mt-8 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium text-slate-900">
              Company name
              <input name="companyName" className={input} value={form.companyName} onChange={set('companyName')} />
            </label>
            <label className="block text-sm font-medium text-slate-900">
              Your name
              <input name="contactName" className={input} value={form.contactName} onChange={set('contactName')} />
            </label>
            <label className="block text-sm font-medium text-slate-900">
              Work email
              <input name="contactEmail" type="email" className={input} value={form.contactEmail} onChange={set('contactEmail')} />
            </label>
            <label className="block text-sm font-medium text-slate-900">
              FDA product code (if you know it)
              <input name="productCode" maxLength={3} className={`${input} uppercase`} value={form.productCode} onChange={set('productCode')} />
            </label>
          </div>
          <label className="block text-sm font-medium text-slate-900">
            What is the device, and what help do you need?
            <textarea name="brief" rows={5} maxLength={2000} className={input} value={form.brief} onChange={set('brief')} />
          </label>
          <div role="group" aria-label="Likely pathway">
            <p className="text-sm font-medium text-slate-900">Likely pathway</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {[...PATHWAYS, { key: 'unsure' as const, label: 'Not sure yet' }].map((p) => (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={pathway === p.key}
                  className={`${chip} ${pathway === p.key ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
                  onClick={() => setPathway(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="hidden" aria-hidden="true">
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input name="consent" type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>I agree that MedexRegAI may share this request with consultant firms that opted in to introductions.</span>
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
            {busy ? 'Sending…' : 'Ask for an introduction'}
          </button>
        </form>
      )}
    </section>
  );
}
