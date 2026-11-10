import PilotRequestForm from '../components/site/PilotRequestForm';
import { CheckList, PageHero, Section } from '../components/site/SiteBlocks';
import { PILOT_FIRM_PROVIDES, PILOT_FIRM_RECEIVES, PILOT_STEPS, PILOT_STATUS } from '../content/site';
import { usePageMeta } from '../hooks/usePageMeta';

/** Optional contact address for pilot requests, set per deployment (no secret). */
const CONTACT_EMAIL: string | undefined = import.meta.env.VITE_CONTACT_EMAIL?.trim() || undefined;

/** The pilot programme: how it runs, what each side brings, and how to apply. */
export default function PilotPage(): JSX.Element {
  usePageMeta({
    title: 'Pilot programme',
    description:
      'Run MedexRegAI on two live 510(k)s and measure hours by activity against your own baseline, with a pilot report your RA lead signs off.',
  });

  return (
    <>
      <PageHero
        eyebrow="Pilot programme"
        title="Measure it on your own 510(k)s"
        intro="The pilot is designed so the result is your firm's own measurement, not our claim: hours by activity on live projects, compared with your baseline."
      >
        <p className="mt-6 inline-flex rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-700">{PILOT_STATUS}</p>
      </PageHero>

      <Section title="How the pilot runs">
        <ol className="grid gap-6 md:grid-cols-3">
          {PILOT_STEPS.map((step, index) => (
            <li key={step.title} className="rounded-xl border border-slate-200 p-6">
              <p className="text-sm font-semibold text-brand-700">Step {index + 1}</p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{step.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="What each side brings" muted>
        <div className="grid gap-8 md:grid-cols-2">
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-900">Your firm provides</h3>
            <div className="mt-4">
              <CheckList items={PILOT_FIRM_PROVIDES} />
            </div>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-900">Your firm receives</h3>
            <div className="mt-4">
              <CheckList items={PILOT_FIRM_RECEIVES} />
            </div>
          </div>
        </div>
        <p className="mt-6 text-sm text-slate-600">Pilot terms are agreed with each firm.</p>
      </Section>

      <Section id="request" title="Request a pilot">
        <div className="max-w-3xl rounded-xl border border-brand-100 bg-brand-50 p-6">
          <p className="mb-6 text-slate-700">
            Tell us about your firm and the 510(k)s you have coming up, and we will arrange a short call.
          </p>
          <PilotRequestForm />
          {CONTACT_EMAIL && (
            <p className="mt-6 text-sm text-slate-600">
              Prefer email? Write to{' '}
              <a className="font-semibold text-brand-700 hover:underline" href={`mailto:${CONTACT_EMAIL}`}>
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          )}
        </div>
      </Section>
    </>
  );
}
