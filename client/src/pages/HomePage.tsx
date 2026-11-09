import { Link } from 'react-router-dom';

interface Feature {
  title: string;
  body: string;
  icon: string;
}

interface Step {
  title: string;
  body: string;
}

interface Principle {
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    title: 'Connect the client folder, read-only',
    body: 'Link Dropbox, Box, SharePoint/OneDrive or Google Drive, or send clients an upload link that needs no account. Files stay where they are.',
    icon: '🔗',
  },
  {
    title: 'Every file sorted by eSTAR section',
    body: 'Test reports, protocols, specifications, drawings and raw data are classified with the reason shown. Unclear versions are asked about, never chosen silently.',
    icon: '🗂️',
  },
  {
    title: 'Gaps and contradictions, side by side',
    body: 'See where the IFU, specification, drawing and test reports disagree, with both source pages open, and draft the client request in one step.',
    icon: '⚖️',
  },
  {
    title: 'Word drafts with sources in the margin',
    body: 'Evidence-heavy sections arrive in Word with a comment naming the file, version and page behind each statement. Statements without a source are removed.',
    icon: '📝',
  },
];

const STEPS: Step[] = [
  { title: 'Connect', body: 'Link the client project folder or share an upload link.' },
  { title: 'Read and sort', body: 'Files are read, versioned and mapped to eSTAR sections.' },
  { title: 'Find problems', body: 'Missing items and conflicting values are listed with their sources.' },
  { title: 'Draft', body: 'Sections and summary tables are drafted in Word, each statement cited.' },
  { title: 'You decide and file', body: 'You review in Word, approve, and file the eSTAR yourself.' },
];

const PRINCIPLES: Principle[] = [
  { title: 'Every fact shows its source', body: 'File, version and page for client documents; record and date for FDA data.' },
  { title: 'The consultant decides', body: 'Nothing goes to a client without your approval, and your edits are recorded as yours.' },
  { title: 'We never file or sign', body: 'You fill and file the eSTAR. Signature fields stay blank.' },
  { title: 'Client data stays separate', body: 'Strict separation between clients, no AI training on your data, deletion per project.' },
];

/** Public landing page: what MedexRegAI does and how a consultant gets started. */
export default function HomePage(): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6" aria-label="Main">
          <Link to="/" className="text-lg font-semibold text-brand-900">
            MedexRegAI
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/login" className="rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:text-brand-700">
              Sign in
            </Link>
            <Link
              to="/signup"
              className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Get started
            </Link>
          </div>
        </nav>
      </header>

      <main className="flex-1">
        <section className="bg-gradient-to-b from-brand-50 to-white" aria-labelledby="hero-heading">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-28">
            <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">For 510(k) regulatory consultants</p>
            <h1 id="hero-heading" className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
              Turn client files into eSTAR-ready 510(k) sections
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
              MedexRegAI reads your client&apos;s folder where it already sits, sorts every file into an eSTAR
              section, flags what is missing or contradictory, and drafts sections in Word with every statement
              linked to its source page. You review, decide and file.
            </p>
            <div className="mt-10 flex flex-wrap gap-4">
              <Link
                to="/signup"
                className="rounded-md bg-brand-600 px-6 py-3 text-base font-semibold text-white shadow-sm hover:bg-brand-700"
              >
                Get started
              </Link>
              <a
                href="#how-it-works"
                className="rounded-md border border-slate-300 px-6 py-3 text-base font-semibold text-slate-800 hover:border-brand-600 hover:text-brand-700"
              >
                See how it works
              </a>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6" aria-labelledby="features-heading">
          <h2 id="features-heading" className="text-2xl font-bold text-slate-900 sm:text-3xl">
            Built around the work clients send you
          </h2>
          <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="rounded-xl border border-slate-200 p-6 shadow-sm">
                <span className="text-3xl" aria-hidden="true">
                  {feature.icon}
                </span>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">{feature.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{feature.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="how-it-works" className="bg-slate-50" aria-labelledby="how-heading">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="how-heading" className="text-2xl font-bold text-slate-900 sm:text-3xl">
              How it works
            </h2>
            <ol className="mt-10 grid gap-6 md:grid-cols-5">
              {STEPS.map((step, index) => (
                <li key={step.title} className="rounded-xl bg-white p-5 shadow-sm">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">
                    {index + 1}
                  </span>
                  <h3 className="mt-3 font-semibold text-slate-900">{step.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6" aria-labelledby="principles-heading">
          <h2 id="principles-heading" className="text-2xl font-bold text-slate-900 sm:text-3xl">
            What never changes
          </h2>
          <dl className="mt-10 grid gap-6 sm:grid-cols-2">
            {PRINCIPLES.map((principle) => (
              <div key={principle.title} className="border-l-4 border-brand-600 pl-4">
                <dt className="font-semibold text-slate-900">{principle.title}</dt>
                <dd className="mt-1 text-sm leading-6 text-slate-600">{principle.body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="bg-brand-900" aria-labelledby="cta-heading">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 id="cta-heading" className="text-2xl font-bold text-white">
                Start with one client project
              </h2>
              <p className="mt-2 text-brand-100">Connect a folder and see it sorted by eSTAR section.</p>
            </div>
            <Link
              to="/signup"
              className="rounded-md bg-white px-6 py-3 text-base font-semibold text-brand-900 hover:bg-brand-50"
            >
              Create your firm workspace
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} MedexRegAI</p>
          <p>MedexRegAI drafts and checks. The consultant reviews, files and signs.</p>
        </div>
      </footer>
    </div>
  );
}
