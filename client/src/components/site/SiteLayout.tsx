import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { NAV_ITEMS } from '../../content/site';

const navLinkClass = ({ isActive }: { isActive: boolean }): string =>
  `rounded-md px-3 py-2 text-sm font-medium ${
    isActive ? 'text-brand-700' : 'text-slate-700 hover:text-brand-700'
  }`;

/** Header, mobile menu and footer shared by every public page. */
export default function SiteLayout(): JSX.Element {
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const location = useLocation();

  // Close the mobile menu and return to the top whenever the route changes.
  useEffect(() => {
    setMenuOpen(false);
    if (!location.hash) {
      window.scrollTo(0, 0);
    }
  }, [location.pathname, location.hash]);

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6" aria-label="Main">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold text-brand-900">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white" aria-hidden="true">
              M
            </span>
            MedexRegAI
          </Link>

          <div className="hidden items-center gap-1 lg:flex">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} className={navLinkClass}>
                {item.label}
              </NavLink>
            ))}
          </div>

          <div className="hidden items-center gap-2 lg:flex">
            <Link to="/login" className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:text-brand-700">
              Sign in
            </Link>
            <Link to="/pilot" className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
              Request a pilot
            </Link>
          </div>

          <button
            type="button"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 lg:hidden"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? 'Close' : 'Menu'}
          </button>
        </nav>

        {menuOpen && (
          <div id="mobile-menu" className="border-t border-slate-200 bg-white px-4 pb-4 lg:hidden">
            <ul className="flex flex-col py-2">
              {NAV_ITEMS.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} className={navLinkClass}>
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Link to="/login" className="flex-1 rounded-md border border-slate-300 px-4 py-2 text-center text-sm font-medium">
                Sign in
              </Link>
              <Link to="/pilot" className="flex-1 rounded-md bg-brand-600 px-4 py-2 text-center text-sm font-semibold text-white">
                Request a pilot
              </Link>
            </div>
          </div>
        )}
      </header>

      <main id="main" className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-4">
          <div className="md:col-span-2">
            <p className="text-lg font-semibold text-brand-900">MedexRegAI</p>
            <p className="mt-2 max-w-sm text-sm leading-6 text-slate-600">
              Client evidence to eSTAR-ready 510(k) sections, with every statement linked to its source page.
            </p>
          </div>
          <nav aria-label="Footer">
            <p className="text-sm font-semibold text-slate-900">Explore</p>
            <ul className="mt-3 space-y-2 text-sm">
              {NAV_ITEMS.map((item) => (
                <li key={item.to}>
                  <Link to={item.to} className="text-slate-600 hover:text-brand-700">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div>
            <p className="text-sm font-semibold text-slate-900">Our boundaries</p>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              MedexRegAI drafts and checks. The consultant reviews, decides, files and signs.
            </p>
          </div>
        </div>
        <div className="border-t border-slate-200">
          <p className="mx-auto max-w-6xl px-4 py-6 text-sm text-slate-500 sm:px-6">
            © {new Date().getFullYear()} MedexRegAI. Not affiliated with the U.S. Food and Drug Administration.
          </p>
        </div>
      </footer>
    </div>
  );
}
