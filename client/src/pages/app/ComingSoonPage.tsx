import { Link, useParams } from 'react-router-dom';
import { useNavigation } from '../../components/app/AppLayout';
import { usePageMeta } from '../../hooks/usePageMeta';

/** Placeholder for menu items that are enabled for this phase but not built yet. */
export default function ComingSoonPage(): JSX.Element {
  const { key, section } = useParams();
  const nav = useNavigation();
  const item = nav?.items.find((i) => i.key === (section ?? key));
  usePageMeta({ title: item?.label ?? 'Coming soon', description: item?.description ?? 'This screen is on the way.' });

  if (nav && !item) {
    return (
      <section className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="text-2xl font-bold text-slate-900">Not available</h1>
        <p className="mt-2 text-slate-600">This screen is not enabled for your firm.</p>
        <Link to="/app" className="mt-4 inline-block font-semibold text-brand-700 hover:underline">
          Back to your workspace
        </Link>
      </section>
    );
  }
  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-bold text-slate-900">{item?.label ?? 'Loading…'}</h1>
      {item && (
        <>
          <p className="mt-2 text-slate-700">{item.description}.</p>
          <p className="mt-4 rounded-md bg-brand-50 px-4 py-3 text-sm text-brand-900">This screen is being built for phase {item.phase}.</p>
        </>
      )}
    </section>
  );
}
