import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import AppLayout from './components/app/AppLayout';
import SiteLayout from './components/site/SiteLayout';
import HomePage from './pages/HomePage';

// Content pages load on demand so the homepage bundle stays small (E8 F8.5).
const ProductPage = lazy(() => import('./pages/ProductPage'));
const HowItWorksPage = lazy(() => import('./pages/HowItWorksPage'));
const SecurityPage = lazy(() => import('./pages/SecurityPage'));
const PilotPage = lazy(() => import('./pages/PilotPage'));
const FaqPage = lazy(() => import('./pages/FaqPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));
const ContactPage = lazy(() => import('./pages/ContactPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const SignUpPage = lazy(() => import('./pages/auth/SignUpPage'));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'));
const InviteAcceptPage = lazy(() => import('./pages/auth/InviteAcceptPage'));
const SsoSignupPage = lazy(() => import('./pages/auth/SsoSignupPage'));
const SsoCompletePage = lazy(() => import('./pages/auth/SsoCompletePage'));
const ClientsPage = lazy(() => import('./pages/app/ClientsPage'));
const ProjectPage = lazy(() => import('./pages/app/ProjectPage'));
const ProjectFilesPage = lazy(() => import('./pages/app/ProjectFilesPage'));
const AiSettingsPage = lazy(() => import('./pages/app/AiSettingsPage'));
const FdaLookupPage = lazy(() => import('./pages/app/FdaLookupPage'));
const FdaSourcesPage = lazy(() => import('./pages/app/FdaSourcesPage'));
const ComingSoonPage = lazy(() => import('./pages/app/ComingSoonPage'));
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
            <Route path="/contact" element={<ContactPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignUpPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/invite/:token" element={<InviteAcceptPage />} />
            <Route path="/sso/complete" element={<SsoCompletePage />} />
            <Route path="/signup/sso" element={<SsoSignupPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route path="/app" element={<WorkspacePage />} />
            <Route path="/app/clients" element={<ClientsPage />} />
            <Route path="/app/projects/:projectId" element={<ProjectPage />} />
            <Route path="/app/projects/:projectId/files" element={<ProjectFilesPage />} />
            <Route path="/app/projects/:projectId/:section" element={<ComingSoonPage />} />
            <Route path="/app/settings/ai" element={<AiSettingsPage />} />
            <Route path="/app/fda-lookup" element={<FdaLookupPage />} />
            <Route path="/app/fda-sources" element={<FdaSourcesPage />} />
            <Route path="/app/soon/:key" element={<ComingSoonPage />} />
          </Route>
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
