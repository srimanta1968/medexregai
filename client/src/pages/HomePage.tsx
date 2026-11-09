import { Link } from 'react-router-dom';
import ProductPreview from '../components/site/ProductPreview';
import { CtaBanner, Section } from '../components/site/SiteBlocks';
import { HOME_FEATURES, PILOT_STATUS, PRINCIPLES, STEPS } from '../content/site';
import { usePageMeta } from '../hooks/usePageMeta';

/** Public landing page: what MedexRegAI does and how a consultant gets started. */
export default function HomePage(): JSX.Element {
  usePageMeta({
    title: 'MedexRegAI',
    description:
      'MedexRegAI helps 510(k) consultants turn client files into eSTAR-ready, source-cited sections. Read-only intake, gaps and contradictions, Word drafts with sources.',
  });

  return (
    <>
      <section className="bg-gradient-to-b from-brand-50 to-white" aria-labelledby="hero-heading">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-24">
          <div>
            <p className="inline-flex rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-700">{PILOT_STATUS}</p>
            <h1 id="hero-heading" className="mt-5 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
              Turn client files into eSTAR-ready 510(k) sections
            </h1>
            <p className="mt-6 text-lg leading-8 text-slate-600">
              MedexRegAI reads your client&apos;s folder where it already sits, sorts every file into an eSTAR section,
              flags what is missing or contradictory, and drafts sections in Word with every statement linked to its
              source page. You review, decide and file.
            </p>
            <div className="mt-10 flex flex-wrap gap-4">
              <Link to="/pilot" className="rounded-md bg-brand-600 px-6 py-3 text-base font-semibold text-white shadow-sm hover:bg-brand-700">
                Request a pilot
              </Link>
              <Link
                to="/how-it-works"
                className="rounded-md border border-slate-300 px-6 py-3 text-base font-semibold text-slate-800 hover:border-brand-600 hover:text-brand-700"
              >
                See how it works
              </Link>
            </div>
          </div>
          <ProductPreview />
        </div>
      </section>

      <Section title="Built around the work clients send you" intro="Turning client material into a submission is where much of a 510(k) project's effort goes. MedexRegAI starts there.">
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {HOME_FEATURES.map((feature) => (
            <li key={feature.title} className="rounded-xl border border-slate-200 p-6 shadow-sm">
              <h3 className="text-lg font-semibold text-slate-900">{feature.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{feature.body}</p>
            </li>
          ))}
        </ul>
        <p className="mt-8">
          <Link to="/product" className="font-semibold text-brand-700 hover:underline">
            Explore the product
          </Link>
        </p>
      </Section>

      <Section id="how-it-works" title="How it works" muted>
        <ol className="grid gap-6 md:grid-cols-5">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-xl bg-white p-5 shadow-sm">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white" aria-hidden="true">
                {index + 1}
              </span>
              <h3 className="mt-3 font-semibold text-slate-900">{step.title}</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600">{step.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="What never changes">
        <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {PRINCIPLES.map((principle) => (
            <div key={principle.title} className="border-l-4 border-brand-600 pl-4">
              <dt className="font-semibold text-slate-900">{principle.title}</dt>
              <dd className="mt-1 text-sm leading-6 text-slate-600">{principle.body}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-8">
          <Link to="/security" className="font-semibold text-brand-700 hover:underline">
            Read how we handle client data
          </Link>
        </p>
      </Section>

      <CtaBanner
        title="Start with one client project"
        body="Join the pilot programme and measure the result against your own baseline."
        ctaLabel="Request a pilot"
        ctaTo="/pilot"
      />
    </>
  );
}
