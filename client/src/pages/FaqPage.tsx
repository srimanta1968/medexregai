import { CtaBanner, PageHero, Section } from '../components/site/SiteBlocks';
import { FAQS } from '../content/site';
import { usePageMeta } from '../hooks/usePageMeta';

/** Frequently asked questions; native <details> keeps it keyboard and screen-reader friendly. */
export default function FaqPage(): JSX.Element {
  usePageMeta({
    title: 'FAQ',
    description:
      'Answers on filing, client accounts, file stores, AI training, Word review, eQMS fit, validation, new file versions, deletion and pilot terms.',
  });

  return (
    <>
      <PageHero
        eyebrow="FAQ"
        title="Questions consultants ask us"
        intro="Short answers on how MedexRegAI fits the way your firm already works."
      />
      <Section title="Frequently asked questions">
        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200">
          {FAQS.map((faq) => (
            <details key={faq.question} className="group px-6 py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-slate-900">
                {faq.question}
                <span className="text-brand-700 transition group-open:rotate-45" aria-hidden="true">
                  +
                </span>
              </summary>
              <p className="mt-3 leading-7 text-slate-600">{faq.answer}</p>
            </details>
          ))}
        </div>
      </Section>
      <CtaBanner
        title="Have a question we did not answer?"
        body="Ask us as part of a pilot conversation."
        ctaLabel="Request a pilot"
        ctaTo="/pilot"
      />
    </>
  );
}
