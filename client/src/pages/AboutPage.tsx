import { CtaBanner, PageHero, Section } from '../components/site/SiteBlocks';
import { PRINCIPLES } from '../content/site';
import { usePageMeta } from '../hooks/usePageMeta';

/** Why MedexRegAI exists and the principles it is built on. */
export default function AboutPage(): JSX.Element {
  usePageMeta({
    title: 'About',
    description:
      'MedexRegAI is shaped by feedback from practising 510(k) consultants and starts where that feedback points: turning client material into a submission.',
  });

  return (
    <>
      <PageHero
        eyebrow="About"
        title="Shaped by 510(k) consultants, around their real work"
        intro="Consultant feedback pointed us away from research tools and towards the harder part of the job: managing the information clients send and turning it into a submission."
      />
      <Section title="Why we started with client files">
        <div className="max-w-3xl space-y-4 leading-7 text-slate-700">
          <p>
            Test reports, protocols, raw data, specifications and drawings arrive in Word, Excel, PowerPoint and PDF,
            in more versions than anyone would like. Finding the current file, chasing what is missing and reconciling
            documents that disagree takes time before a single section is written.
          </p>
          <p>
            So MedexRegAI starts at the client folder: it reads, sorts and checks first, then drafts the evidence-heavy
            sections in Word, with every statement traceable to its source. It fits around the tools firms already
            run and never replaces the consultant&apos;s judgement.
          </p>
          <p>
            We are building in the order measured hours suggest, and changing that order when the measurements change.
            Pilot firms shape what comes next.
          </p>
        </div>
      </Section>
      <Section title="Our principles" muted>
        <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {PRINCIPLES.map((principle) => (
            <div key={principle.title} className="rounded-xl bg-white p-5 shadow-sm">
              <dt className="font-semibold text-slate-900">{principle.title}</dt>
              <dd className="mt-1 text-sm leading-6 text-slate-600">{principle.body}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <CtaBanner
        title="Help shape what we build"
        body="Pilot firms work directly with the team."
        ctaLabel="Request a pilot"
        ctaTo="/pilot"
      />
    </>
  );
}
