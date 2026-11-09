import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
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
const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const SignUpPage = lazy(() => import('./pages/auth/SignUpPage'));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'));
const InviteAcceptPage = lazy(() => import('./pages/auth/InviteAcceptPage'));
const SsoCompletePage = lazy(() => import('./pages/auth/SsoCompletePage'));
const WorkspacePage = lazy(() => import('./pages/app/WorkspacePage'));

function PageLoading(): JSX.Element {
  return (
    <p className="mx-auto max-w-6xl px-4 py-16 text-slate-500 sm:px-6" role="status">
      Loading…
    </p>
  );
}

/** Top-level routes: public site, account pages (F0.1) and the signed-in workspace. */
export default function App(): JSX.Element {
  return (
    <AuthProvider>
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
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignUpPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/invite/:token" element={<InviteAcceptPage />} />
            <Route path="/sso/complete" element={<SsoCompletePage />} />
            <Route
              path="/app"
              element={
                <RequireAuth>
                  <WorkspacePage />
                </RequireAuth>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
