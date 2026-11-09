import { CtaBanner, PageHero, Section } from '../components/site/SiteBlocks';
import { STEPS } from '../content/site';
import { usePageMeta } from '../hooks/usePageMeta';

interface Responsibility {
  step: string;
  medexregai: string;
  consultant: string;
}

const RESPONSIBILITIES: Responsibility[] = [
  { step: 'Connect', medexregai: 'Reads the folder you choose, read-only', consultant: 'Chooses the folder and approves the scope' },
  { step: 'Sort', medexregai: 'Proposes a document type, eSTAR section and current version', consultant: 'Confirms unclear versions and corrects any section' },
  { step: 'Problems', medexregai: 'Lists gaps and contradictions with both sources', consultant: 'Decides: resolve, accept with a reason, or ask the client' },
  { step: 'Client request', medexregai: 'Drafts the request and tracks responses', consultant: 'Edits and approves every message before it is sent' },
  { step: 'Draft', medexregai: 'Drafts sections and tables, each statement cited', consultant: 'Reviews and edits in Word' },
  { step: 'File', medexregai: 'Checks attachments and produces dated records', consultant: 'Fills, signs and files the eSTAR' },
];

/** The end-to-end workflow and who does what at each step. */
export default function HowItWorksPage(): JSX.Element {
  usePageMeta({
    title: 'How it works',
    description:
      'Connect a client folder, sort every file into eSTAR sections, resolve gaps and contradictions, and review cited drafts in Word. The consultant decides and files.',
  });

  return (
    <>
      <PageHero
        eyebrow="How it works"
        title="Five steps, and you decide at every one"
        intro="MedexRegAI does the reading, sorting, checking and first drafting. You make every decision, approve everything that reaches your client, and file."
      />
      <Section title="The workflow">
        <ol className="space-y-6">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-5 rounded-xl border border-slate-200 p-6">
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-brand-600 font-semibold text-white" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <h3 className="text-lg font-semibold text-slate-900">{step.title}</h3>
                <p className="mt-1 text-slate-600">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-slate-600">
          Whenever a client sends a new version of a file, it is read and checked again, and you see exactly which
          statements and tables cited the old version.
        </p>
      </Section>
      <Section title="Who does what" muted>
        {/* Scrolls sideways on small screens; focusable so keyboard users can scroll it (WCAG 2.1.1). */}
        <div
          className="overflow-x-auto rounded-xl border border-slate-200 bg-white"
          role="region"
          aria-label="Who does what at each step"
          tabIndex={0}
        >
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Responsibilities of MedexRegAI and the consultant at each step</caption>
            <thead className="bg-slate-50 text-slate-900">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">Step</th>
                <th scope="col" className="px-4 py-3 font-semibold">MedexRegAI</th>
                <th scope="col" className="px-4 py-3 font-semibold">You</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {RESPONSIBILITIES.map((row) => (
                <tr key={row.step}>
                  <th scope="row" className="px-4 py-3 font-medium text-slate-900">{row.step}</th>
                  <td className="px-4 py-3">{row.medexregai}</td>
                  <td className="px-4 py-3">{row.consultant}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <CtaBanner
        title="Try it on a live 510(k)"
        body="The pilot measures hours against your own baseline."
        ctaLabel="Request a pilot"
        ctaTo="/pilot"
      />
    </>
  );
}
