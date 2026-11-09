import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export interface PageHeroProps {
  eyebrow: string;
  title: string;
  intro: string;
  children?: ReactNode;
}

/** Top banner for content pages: one h1 per page (WCAG 1.3.1, 2.4.6). */
export function PageHero({ eyebrow, title, intro, children }: PageHeroProps): JSX.Element {
  return (
    <section className="bg-gradient-to-b from-brand-50 to-white" aria-labelledby="page-title">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">{eyebrow}</p>
        <h1 id="page-title" className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
          {title}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">{intro}</p>
        {children}
      </div>
    </section>
  );
}

export interface SectionProps {
  id?: string;
  title: string;
  intro?: string;
  muted?: boolean;
  children: ReactNode;
}

/** A titled page section with consistent spacing. */
export function Section({ id, title, intro, muted = false, children }: SectionProps): JSX.Element {
  const headingId = `${id || title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-heading`;
  return (
    <section id={id} className={muted ? 'bg-slate-50' : undefined} aria-labelledby={headingId}>
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id={headingId} className="text-2xl font-bold text-slate-900 sm:text-3xl">
          {title}
        </h2>
        {intro && <p className="mt-3 max-w-2xl text-slate-600">{intro}</p>}
        <div className="mt-10">{children}</div>
      </div>
    </section>
  );
}

export interface CtaBannerProps {
  title: string;
  body: string;
  ctaLabel: string;
  ctaTo: string;
}

/** Closing call to action on each page. */
export function CtaBanner({ title, body, ctaLabel, ctaTo }: CtaBannerProps): JSX.Element {
  return (
    <section className="bg-brand-900" aria-labelledby="cta-heading">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 id="cta-heading" className="text-2xl font-bold text-white">
            {title}
          </h2>
          <p className="mt-2 text-brand-100">{body}</p>
        </div>
        <Link to={ctaTo} className="rounded-md bg-white px-6 py-3 text-base font-semibold text-brand-900 hover:bg-brand-50">
          {ctaLabel}
        </Link>
      </div>
    </section>
  );
}

export interface CheckListProps {
  items: string[];
}

/** Bulleted list with check marks; the marks are decorative. */
export function CheckList({ items }: CheckListProps): JSX.Element {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item} className="flex gap-3 text-sm leading-6 text-slate-700">
          <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700" aria-hidden="true">
            ✓
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
