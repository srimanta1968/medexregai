import { Link } from 'react-router-dom';
import { usePageMeta } from '../hooks/usePageMeta';

export interface NotFoundPageProps {
  /** Optional explanation, e.g. for a screen that is not built yet. */
  message?: string;
}

/** Fallback for unknown routes. Rendered inside SiteLayout's <main>, so it is a section. */
export default function NotFoundPage({
  message = 'The page you were looking for does not exist yet.',
}: NotFoundPageProps): JSX.Element {
  usePageMeta({ title: 'Page not found', description: 'This page does not exist on the MedexRegAI website.' });

  return (
    <section className="flex flex-col items-center justify-center px-4 py-24 text-center" aria-labelledby="not-found-title">
      <p className="text-sm font-semibold text-brand-700">404</p>
      <h1 id="not-found-title" className="mt-2 text-3xl font-bold text-slate-900">
        Page not found
      </h1>
      <p className="mt-3 text-slate-600">{message}</p>
      <Link to="/" className="mt-8 rounded-md bg-brand-600 px-5 py-2.5 font-semibold text-white hover:bg-brand-700">
        Back to home
      </Link>
    </section>
  );
}
