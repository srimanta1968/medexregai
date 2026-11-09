import { Link } from 'react-router-dom';

export interface NotFoundPageProps {
  /** Optional explanation, e.g. for a screen that is not built yet. */
  message?: string;
}

/** Fallback for unknown routes. */
export default function NotFoundPage({
  message = 'The page you were looking for does not exist yet.',
}: NotFoundPageProps): JSX.Element {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <p className="text-sm font-semibold text-brand-700">404</p>
      <h1 className="mt-2 text-3xl font-bold text-slate-900">Page not found</h1>
      <p className="mt-3 text-slate-600">{message}</p>
      <Link to="/" className="mt-8 rounded-md bg-brand-600 px-5 py-2.5 font-semibold text-white hover:bg-brand-700">
        Back to home
      </Link>
    </main>
  );
}
