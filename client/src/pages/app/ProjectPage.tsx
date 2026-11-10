import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { FormMessage } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { ProjectDetail, SUBMISSION_TYPE_LABELS, workspaceApi } from '../../lib/workspaceApi';

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
          <h1 className="mt-1 text-2xl font-bold text-slate-900">{project.name}</h1>
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
        </>
      )}
    </section>
  );
}
