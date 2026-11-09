import { CheckList, CtaBanner, PageHero, Section } from '../components/site/SiteBlocks';
import { SECURITY_SECTIONS } from '../content/site';
import { usePageMeta } from '../hooks/usePageMeta';

/** Security, privacy and data handling, written for a firm's quality and IT owner. */
export default function SecurityPage(): JSX.Element {
  usePageMeta({
    title: 'Security and trust',
    description:
      'Read-only connectors, strict client separation, self-hosted AI by default, no training on your data, per-project deletion and a free validation pack.',
  });

  return (
    <>
      <PageHero
        eyebrow="Security and trust"
        title="Client files are confidential. We built around that."
        intro="Written for your quality and IT owner: what we access, where data goes, and how you stay in control."
      />
      <Section
        title="How client data is handled, by design"
        intro="MedexRegAI is in its pilot phase. These are the controls every pilot release is built and tested against, and the data-handling pack documents each one."
      >
        <div className="grid gap-8 md:grid-cols-2">
          {SECURITY_SECTIONS.map((section) => (
            <article key={section.title} className="rounded-xl border border-slate-200 p-6 shadow-sm">
              <h3 className="text-xl font-semibold text-slate-900">{section.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{section.body}</p>
              <div className="mt-5">
                <CheckList items={section.points} />
              </div>
            </article>
          ))}
        </div>
      </Section>
      <Section title="Your trust pack" muted>
        <p className="max-w-3xl text-slate-700">
          Every pilot firm receives a validation pack (intended use, risk assessment template, test evidence, release
          notes and model change log) and a data-handling pack (where data goes, subprocessors, retention and
          deletion), plus a clause you can give your own clients. Both are free and updated with every release.
        </p>
        <p className="mt-4 max-w-3xl text-sm text-slate-600">
          This page summarises our approach. The data-handling pack and your agreement with us are the documents that
          govern how your data is processed.
        </p>
      </Section>
      <CtaBanner
        title="Questions from your quality or IT owner?"
        body="We will walk them through the packs as part of the pilot."
        ctaLabel="Request a pilot"
        ctaTo="/pilot"
      />
    </>
  );
}
