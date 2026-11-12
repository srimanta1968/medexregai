import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { EstarSection } from '../../lib/sortingApi';
import { FirmTemplate, Precedent, StyleSettings, styleApi } from '../../lib/styleApi';

const card = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';
const input = 'mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const primary = 'rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60';
const secondary = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * F3.6 template manager: the firm's own section templates and its library of past wording.
 * Opt-in (off until the firm turns it on), used only for this firm, and style only: drafting
 * follows a template's order and the wording's tone, while every fact still comes from the
 * client's files and passes the citation check.
 */
export default function FirmTemplatesPage(): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => styleApi(authedRequest), [authedRequest]);
  usePageMeta({ title: 'Templates and past wording', description: "Your firm's section templates and past wording, used when drafting." });
  const [settings, setSettings] = useState<StyleSettings | null>(null);
  const [templates, setTemplates] = useState<FirmTemplate[]>([]);
  const [precedents, setPrecedents] = useState<Precedent[]>([]);
  const [sections, setSections] = useState<EstarSection[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tpl, setTpl] = useState({ sectionId: 'device_description', name: '', body: '' });
  const [prec, setPrec] = useState({ sectionId: 'device_description', sourceLabel: '', text: '' });

  const load = useCallback(() => {
    Promise.all([api.settings(), api.templates(), api.precedents(), authedRequest<EstarSection[]>('/api/estar-sections')])
      .then(([s, t, p, secs]) => {
        setSettings(s);
        setTemplates(t.items);
        setPrecedents(p.items);
        setSections(secs.filter((x) => x.takesEvidence));
      })
      .catch((err: unknown) => setError(message(err, 'Could not load your templates.')));
  }, [api, authedRequest]);
  useEffect(load, [load]);

  const run = async (work: () => Promise<void>, done: string, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      load();
    } catch (err) {
      setError(message(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (on: boolean) =>
    void run(
      async () => setSettings(await api.setEnabled(on)),
      on ? 'Firm style sources are on: drafts started from now follow your templates and past wording.' : 'Firm style sources are off: drafts started from now use none of them.',
      'Could not change the setting.',
    );

  const templateReady = tpl.name.trim() !== '' && tpl.body.trim() !== '';
  const precedentReady = prec.sourceLabel.trim() !== '' && prec.text.trim() !== '';

  const addTemplate = () => {
    // A repeated click after the add (the fields are cleared) or while saving does nothing.
    if (!templateReady || busy) return;
    void run(
      async () => {
        await api.createTemplate(tpl);
        setTpl((t) => ({ ...t, name: '', body: '' }));
      },
      `Template added: ${tpl.name}.`,
      'Could not add the template.',
    );
  };

  const addPrecedent = () => {
    if (!precedentReady || busy) return;
    void run(
      async () => {
        await api.createPrecedent(prec);
        setPrec((p) => ({ ...p, sourceLabel: '', text: '' }));
      },
      `Past wording added from ${prec.sourceLabel}.`,
      'Could not add the wording.',
    );
  };

  const sectionOptions = sections.map((s) => (
    <option key={s.id} value={s.id}>
      {s.title}
    </option>
  ));

  return (
    <section className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Templates and past wording</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        Your firm&apos;s outline for a section and wording from its past submissions. Drafting follows a template&apos;s order and the wording&apos;s tone; every fact still
        comes from the client&apos;s files and must cite one. They are used only for your firm.
      </p>
      <div aria-live="polite" className="mt-3 space-y-2">
        {notice && <FormMessage tone="success">{notice}</FormMessage>}
        {error && <FormMessage tone="error">{error}</FormMessage>}
      </div>

      <section aria-labelledby="style-switch" className={`${card} mt-6`}>
        <h2 id="style-switch" className="text-lg font-semibold text-slate-900">
          Use firm style when drafting
        </h2>
        {settings === null ? (
          <p role="status" className="mt-2 text-sm text-slate-500">
            Loading…
          </p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-sm text-slate-800">
                {settings.enabled ? 'On: new drafts follow your templates and past wording' : 'Off: new drafts use no templates or past wording'}
              </p>
              {settings.enabled ? (
                <button key="off" type="button" name="styleOff" className={secondary} onClick={() => toggle(false)}>
                  Turn off firm style
                </button>
              ) : (
                <button key="on" type="button" name="styleOn" className={primary} onClick={() => toggle(true)}>
                  Turn on firm style
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Off until your firm turns it on. A change applies to every draft started after it; a draft already being written finishes as it began.
              {settings.updatedAt && ` Last changed ${new Date(settings.updatedAt).toLocaleString()}${settings.updatedByName ? ` by ${settings.updatedByName}` : ''}.`}
            </p>
          </>
        )}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="templates-title" className={card}>
          <h2 id="templates-title" className="text-lg font-semibold text-slate-900">
            Section templates · {templates.length}
          </h2>
          <div className="mt-3 space-y-3" role="group" aria-label="New template">
            <label className="block text-sm font-medium text-slate-900">
              Section
              <select name="templateSection" className={input} value={tpl.sectionId} onChange={(e) => setTpl({ ...tpl, sectionId: e.target.value })}>
                {sectionOptions}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-900">
              Template name
              <input name="templateName" className={input} value={tpl.name} maxLength={200} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} />
            </label>
            <label className="block text-sm font-medium text-slate-900">
              Outline
              <textarea name="templateBody" className={input} rows={4} value={tpl.body} maxLength={20000} onChange={(e) => setTpl({ ...tpl, body: e.target.value })} />
            </label>
            <div className="flex items-center gap-3">
              <button type="button" name="addTemplate" className={primary} aria-disabled={!templateReady} onClick={addTemplate}>
                Add template
              </button>
              {!templateReady && <span className="text-xs text-slate-500">Needs a name and an outline.</span>}
            </div>
          </div>
          <ul className="mt-4 space-y-3">
            {templates.map((t) => (
              <li key={t.id} className="rounded-xl border border-slate-200 p-3 text-sm">
                <p className="font-medium text-slate-900">
                  {t.sectionTitle}: {t.name}
                </p>
                <p className="mt-1 whitespace-pre-line text-slate-700">{t.body}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-slate-700">
                    <input
                      type="checkbox"
                      aria-label={`Use the ${t.sectionTitle} template when drafting`}
                      checked={t.enabled}
                      disabled={busy}
                      onChange={(e) => void run(async () => void (await api.updateTemplate(t.id, { enabled: e.target.checked })), e.target.checked ? `${t.sectionTitle} template in use.` : `${t.sectionTitle} template turned off.`, 'Could not change the template.')}
                    />
                    Use when drafting
                  </label>
                  <button type="button" className={secondary} disabled={busy} onClick={() => void run(() => api.deleteTemplate(t.id), `Template deleted: ${t.name}.`, 'Could not delete the template.')}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
            {templates.length === 0 && <li className="text-sm text-slate-500">No templates yet.</li>}
          </ul>
        </section>

        <section aria-labelledby="precedents-title" className={card}>
          <h2 id="precedents-title" className="text-lg font-semibold text-slate-900">
            Past wording · {precedents.length}
          </h2>
          <div className="mt-3 space-y-3" role="group" aria-label="New past wording">
            <label className="block text-sm font-medium text-slate-900">
              Section
              <select name="precedentSection" className={input} value={prec.sectionId} onChange={(e) => setPrec({ ...prec, sectionId: e.target.value })}>
                {sectionOptions}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-900">
              Where it came from
              <input
                name="precedentSource"
                className={input}
                value={prec.sourceLabel}
                maxLength={200}
                required
                placeholder="e.g. K201234, Device description"
                onChange={(e) => setPrec({ ...prec, sourceLabel: e.target.value })}
              />
            </label>
            <label className="block text-sm font-medium text-slate-900">
              Wording
              <textarea name="precedentText" className={input} rows={4} value={prec.text} maxLength={4000} onChange={(e) => setPrec({ ...prec, text: e.target.value })} />
            </label>
            <div className="flex items-center gap-3">
              <button type="button" name="addPrecedent" className={primary} aria-disabled={!precedentReady} onClick={addPrecedent}>
                Add wording
              </button>
              {!precedentReady && <span className="text-xs text-slate-500">Needs where it came from and the wording.</span>}
            </div>
          </div>
          <ul className="mt-4 space-y-3">
            {precedents.map((p) => (
              <li key={p.id} className="rounded-xl border border-slate-200 p-3 text-sm">
                <p className="font-medium text-slate-900">
                  {p.sectionTitle} · {p.sourceLabel}
                </p>
                <p className="mt-1 text-slate-700">{p.text}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-slate-700">
                    <input
                      type="checkbox"
                      aria-label={`Use the wording from ${p.sourceLabel} when drafting`}
                      checked={p.enabled}
                      disabled={busy}
                      onChange={(e) => void run(async () => void (await api.updatePrecedent(p.id, { enabled: e.target.checked })), e.target.checked ? 'Wording in use.' : 'Wording turned off.', 'Could not change the wording.')}
                    />
                    Use when drafting
                  </label>
                  <button type="button" className={secondary} disabled={busy} onClick={() => void run(() => api.deletePrecedent(p.id), 'Wording deleted.', 'Could not delete the wording.')}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
            {precedents.length === 0 && <li className="text-sm text-slate-500">No past wording yet.</li>}
          </ul>
        </section>
      </div>
    </section>
  );
}
