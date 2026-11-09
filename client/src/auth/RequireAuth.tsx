import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

/** Gate for signed-in routes: sends visitors to /login and back again afterwards. */
export function RequireAuth({ children }: { children: ReactNode }): JSX.Element {
  const { session, restoring } = useAuth();
  const location = useLocation();
  if (restoring) {
    return (
      <p className="mx-auto max-w-6xl px-4 py-16 text-slate-500" role="status">
        Loading…
      </p>
    );
  }
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
