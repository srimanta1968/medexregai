import { CheckList, CtaBanner, PageHero, Section } from '../components/site/SiteBlocks';
import { CAPABILITIES } from '../content/site';
import { usePageMeta } from '../hooks/usePageMeta';

/** What MedexRegAI does, capability by capability. */
export default function ProductPage(): JSX.Element {
  usePageMeta({
    title: 'Product',
    description:
      'Read-only intake, eSTAR sorting, contradiction checks, client requests, Word drafts with sources, revision impact and eQMS records for 510(k) consultants.',
  });

  return (
    <>
      <PageHero
        eyebrow="Product"
        title="From client folder to reviewed Word draft"
        intro="Each capability works on the files your client already sends, and every output points back to the file, version and page it came from."
      />
      <Section
        title="Capabilities"
        intro="MedexRegAI is being built with pilot firms. This is what the pilot programme delivers, phase by phase, starting with intake, sorting and the contradiction check."
      >
        <div className="grid gap-8 md:grid-cols-2">
          {CAPABILITIES.map((capability) => (
            <article key={capability.title} className="rounded-xl border border-slate-200 p-6 shadow-sm">
              <h3 className="text-xl font-semibold text-slate-900">{capability.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{capability.body}</p>
              <div className="mt-5">
                <CheckList items={capability.points} />
              </div>
            </article>
          ))}
        </div>
      </Section>
      <Section title="Where it fits" muted>
        <div className="grid gap-6 md:grid-cols-3">
          <div>
            <h3 className="font-semibold text-slate-900">Your file store</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">Files stay in Dropbox, Box, SharePoint or Drive. We connect read-only.</p>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900">Microsoft Word</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">Drafts arrive in Word with sources in comments. You review as you do today.</p>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900">Your eQMS</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">Dated PDF and DOCX records you file by hand. No integration project.</p>
          </div>
        </div>
      </Section>
      <CtaBanner
        title="See it on your own projects"
        body="The pilot programme runs on two of your live 510(k)s."
        ctaLabel="Request a pilot"
        ctaTo="/pilot"
      />
    </>
  );
}
