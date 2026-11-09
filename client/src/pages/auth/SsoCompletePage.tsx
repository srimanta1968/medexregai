import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Session, useAuth } from '../../auth/AuthContext';
import { AuthCard, FormMessage, TextLink } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError, apiRequest } from '../../lib/api';

/**
 * Landing page after Google/Microsoft sign-in. The server put a one-time code in the
 * URL fragment (never sent to servers or logs); trade it for a session exactly once.
 */
export default function SsoCompletePage(): JSX.Element {
  usePageMeta({ title: 'Signing you in', description: 'Completing sign-in to MedexRegAI.' });
  const { adopt } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef<boolean>(false);

  useEffect(() => {
    // The code is single use: StrictMode's second effect run must not send it again.
    if (started.current) {
      return;
    }
    started.current = true;
    const code = new URLSearchParams(window.location.hash.slice(1)).get('code') ?? '';
    window.history.replaceState(null, '', window.location.pathname);
    if (!code) {
      setError('This sign-in link is incomplete. Please try again.');
      return;
    }
    apiRequest<Session>('/api/auth/sso/exchange', { method: 'POST', body: { code } })
      .then((session) => {
        adopt(session);
        navigate('/app', { replace: true });
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.'));
  }, [adopt, navigate]);

  return (
    <AuthCard title="Signing you in" footer={error ? <TextLink to="/login">Back to sign in</TextLink> : undefined}>
      {error ? (
        <FormMessage tone="error">{error}</FormMessage>
      ) : (
        <p role="status" className="text-slate-500">
          Completing sign-in…
        </p>
      )}
    </AuthCard>
  );
}
