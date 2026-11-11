import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import ActivityPanel from '../../components/app/ActivityPanel';
import FdaDataAsOf from '../../components/app/FdaDataAsOf';
import { Field, FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { trustApi } from '../../lib/trustApi';
import { ProjectDetail, SUBMISSION_TYPE_LABELS, workspaceApi } from '../../lib/workspaceApi';

/** Owner/admin only: delete everything held for the project, confirmed by typing its name (F2.5). */
function DeleteProjectData({ project }: { project: ProjectDetail }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => trustApi(authedRequest), [authedRequest]);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const confirmName = String(new FormData(e.currentTarget).get('confirmName') ?? '');
    setBusy(true);
    setError(null);
    try {
      await api.deleteProject(project.id, confirmName);
      navigate('/app/trust-pack', {
        state: { notice: `${project.name} was deleted. Stored files are being removed; the deletion certificate is listed below when it completes.` },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the project.');
      setBusy(false);
    }
  };
  return (
    <section className="rounded-2xl border border-red-200 bg-white p-6 shadow-sm" aria-labelledby="delete-title">
      <h2 id="delete-title" className="text-lg font-semibold text-slate-900">
        Delete project data
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Permanently deletes this project and everything held for it: files and versions, extracted text, search index, drafts, client requests and links. It
        cannot be undone. You get a deletion certificate.
      </p>
      {!open ? (
        <button
          type="button"
          className="mt-4 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-50"
          onClick={() => setOpen(true)}
        >
          Delete this project's data
        </button>
      ) : (
        <form className="mt-4 max-w-md space-y-3" onSubmit={(e) => void submit(e)} noValidate>
          <Field name="confirmName" label={`Type the project name to confirm: ${project.name}`} autoComplete="off" required />
          {error && <FormMessage tone="error">{error}</FormMessage>}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60"
            >
              {busy ? 'Deleting…' : 'Delete project data permanently'}
            </button>
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Project header: firm > client > project, with the device it belongs to. */
export default function ProjectPage(): JSX.Element {
  const { projectId = '' } = useParams();
  const { session, authedRequest } = useAuth();
  const api = useMemo(() => workspaceApi(authedRequest), [authedRequest]);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePageMeta({ title: project?.name ?? 'Submission', description: 'A 510(k) submission project in MedexRegAI.' });

  useEffect(() => {
    let active = true;
    api
      .getProject(projectId)
      .then((p) => {
        if (active) setProject(p);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof ApiError && err.status === 404 ? 'This submission was not found.' : 'Could not load this submission.');
      });
    return () => {
      active = false;
    };
  }, [api, projectId]);

  return (
    <section className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      {error && (
        <>
          <h1 className="text-2xl font-bold text-slate-900">Submission</h1>
          <div className="mt-4">
            <FormMessage tone="error">{error}</FormMessage>
          </div>
          <Link to="/app/clients" className="mt-4 inline-block font-semibold text-brand-700 hover:underline">
            Back to clients and projects
          </Link>
        </>
      )}
      {!error && !project && (
        <p role="status" className="text-slate-500">
          Loading…
        </p>
      )}
      {project && (
        <>
          <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
            <Link to="/app" className="hover:underline">
              {session?.org.name}
            </Link>{' '}
            ›{' '}
            <Link to={`/app/clients?client=${project.clientId}`} className="hover:underline">
              {project.client.name}
            </Link>{' '}
            › <span aria-current="page">{project.name}</span>
          </nav>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-bold text-slate-900">{project.name}</h1>
            <FdaDataAsOf />
          </div>
          <dl className="mt-6 grid gap-4 rounded-2xl border border-slate-200 bg-white p-6 text-sm shadow-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Submission type</dt>
              <dd className="font-medium text-slate-900">{SUBMISSION_TYPE_LABELS[project.submissionType]}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Status</dt>
              <dd className="font-medium capitalize text-slate-900">{project.status}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Device</dt>
              <dd className="font-medium text-slate-900">
                {project.device.name}
                {project.device.modelNames.length > 0 && ` (${project.device.modelNames.join(', ')})`}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">UDI-DI</dt>
              <dd className="font-medium text-slate-900">{project.device.udiDi ?? 'Not recorded yet'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Target date</dt>
              <dd className="font-medium text-slate-900">{project.targetDate ?? 'Not set'}</dd>
            </div>
          </dl>
          <div className="mt-8">
            <ActivityPanel projectId={project.id} />
          </div>
          {(session?.role === 'owner' || session?.role === 'admin') && (
            <div className="mt-8">
              <DeleteProjectData project={project} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
