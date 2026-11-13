import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import TimerWidget from './TimerWidget';

export interface NavItem {
  key: string;
  label: string;
  description: string;
  phase: number;
  scope: 'firm' | 'project';
  built: boolean;
}

interface Navigation {
  phase: number;
  items: NavItem[];
}

const NavContext = createContext<Navigation | null>(null);

/** The menu the server enabled for this user (phase flags + role). */
export function useNavigation(): Navigation | null {
  return useContext(NavContext);
}

/** Where each built firm-level item lives; everything else opens its "coming" page. */
const FIRM_PATHS: Record<string, string> = { clients: '/app/clients', users: '/app', 'ai-settings': '/app/settings/ai', 'trust-pack': '/app/trust-pack', templates: '/app/templates', time: '/app/time', usage: '/app/usage', portfolio: '/app/portfolio', introductions: '/app/introductions' };

export function navPath(item: NavItem, projectId?: string): string {
  if (item.scope === 'project') {
    return projectId ? `/app/projects/${projectId}/${item.key}` : '/app/clients';
  }
  return item.built && FIRM_PATHS[item.key] ? FIRM_PATHS[item.key] : `/app/soon/${item.key}`;
}

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  `block rounded-md px-3 py-2 text-sm ${isActive ? 'bg-brand-50 font-semibold text-brand-800' : 'text-slate-700 hover:bg-slate-100'}`;

/** Signed-in shell: top bar, phase-gated left navigation, page outlet. */
export default function AppLayout(): JSX.Element {
  const { session, logout, authedRequest } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const projectMatch = useMatch('/app/projects/:projectId/*');
  const projectId = projectMatch?.params.projectId;
  const [nav, setNav] = useState<Navigation | null>(null);
  const [open, setOpen] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    authedRequest<Navigation>('/api/app/navigation')
      .then((n) => {
        if (active) setNav(n);
      })
      .catch(() => {
        if (active) setNav({ phase: 1, items: [] });
      });
    return () => {
      active = false;
    };
  }, [authedRequest, session?.org.id]);

  useEffect(() => setOpen(false), [location.pathname]);

  const firmItems = useMemo(() => nav?.items.filter((i) => i.scope === 'firm') ?? [], [nav]);
  const projectItems = useMemo(() => nav?.items.filter((i) => i.scope === 'project') ?? [], [nav]);

  const onSignOut = async (): Promise<void> => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <NavContext.Provider value={nav}>
      <div className="flex min-h-screen flex-col bg-slate-50">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2"
        >
          Skip to content
        </a>
        <header className="border-b border-slate-200 bg-white">
          <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800 lg:hidden"
                aria-expanded={open}
                aria-controls="app-nav"
                onClick={() => setOpen((o) => !o)}
              >
                Menu
              </button>
              <Link to="/app" className="flex items-center gap-2 font-semibold text-brand-900">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white" aria-hidden="true">
                  M
                </span>
                <span className="hidden sm:inline">MedexRegAI</span>
              </Link>
              <span className="text-sm text-slate-500" aria-label="Firm">
                {session?.org.name}
              </span>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <TimerWidget />
              <Link to="/app/account/security" className="hidden text-slate-600 hover:underline md:inline" title="Sign-in security">
                {session?.user.fullName}
              </Link>
              <button type="button" onClick={onSignOut} className="rounded-md border border-slate-300 px-3 py-1.5 font-semibold text-slate-800 hover:bg-slate-50">
                Sign out
              </button>
            </div>
          </div>
        </header>

        <div className="flex flex-1">
          <nav
            id="app-nav"
            aria-label="App"
            className={`${open ? 'block' : 'hidden'} w-64 shrink-0 border-r border-slate-200 bg-white p-4 lg:block`}
          >
            {projectId && projectItems.length > 0 && (
              <div className="mb-6">
                <p className="px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Project</p>
                <ul className="mt-2 space-y-1">
                  <li>
                    <NavLink to={`/app/projects/${projectId}`} end className={linkClass}>
                      Overview
                    </NavLink>
                  </li>
                  {projectItems.map((item) => (
                    <li key={item.key}>
                      <NavLink to={navPath(item, projectId)} className={linkClass} title={item.description}>
                        {item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Firm</p>
            <ul className="mt-2 space-y-1">
              {firmItems.map((item) => (
                <li key={item.key}>
                  <NavLink to={navPath(item)} end={item.key === 'users'} className={linkClass} title={item.description}>
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
            {nav && <p className="mt-6 px-3 text-xs text-slate-400">Phase {nav.phase} features</p>}
          </nav>
          <main id="main" className="flex min-w-0 flex-1 flex-col">
            <Outlet />
          </main>
        </div>
      </div>
    </NavContext.Provider>
  );
}
