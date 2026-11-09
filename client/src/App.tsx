import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import SiteLayout from './components/site/SiteLayout';
import HomePage from './pages/HomePage';

// Content pages load on demand so the homepage bundle stays small (E8 F8.5).
const ProductPage = lazy(() => import('./pages/ProductPage'));
const HowItWorksPage = lazy(() => import('./pages/HowItWorksPage'));
const SecurityPage = lazy(() => import('./pages/SecurityPage'));
const PilotPage = lazy(() => import('./pages/PilotPage'));
const FaqPage = lazy(() => import('./pages/FaqPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

function PageLoading(): JSX.Element {
  return (
    <p className="mx-auto max-w-6xl px-4 py-16 text-slate-500 sm:px-6" role="status">
      Loading…
    </p>
  );
}

/** Top-level routes. Sign-in, sign-up and the app shell arrive with features F0.1/F0.2. */
export default function App(): JSX.Element {
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route element={<SiteLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/product" element={<ProductPage />} />
          <Route path="/how-it-works" element={<HowItWorksPage />} />
          <Route path="/security" element={<SecurityPage />} />
          <Route path="/pilot" element={<PilotPage />} />
          <Route path="/faq" element={<FaqPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
