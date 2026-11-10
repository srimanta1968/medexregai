import PilotRequestForm from '../components/site/PilotRequestForm';
import { PageHero, Section } from '../components/site/SiteBlocks';
import { usePageMeta } from '../hooks/usePageMeta';

export default function ContactPage(): JSX.Element {
  usePageMeta({
    title: 'Contact',
    description: 'Ask about the MedexRegAI pilot programme for 510(k) consulting firms.',
  });
  return (
    <>
      <PageHero
        eyebrow="Contact"
        title="Talk to us about a pilot"
        intro="Tell us about your firm and the 510(k)s you have coming up, and we will arrange a short call."
      />
      <Section id="request" title="Request a pilot">
        <div className="max-w-3xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <PilotRequestForm />
        </div>
      </Section>
    </>
  );
}
