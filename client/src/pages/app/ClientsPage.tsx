import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Field, FormMessage, SubmitButton } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { ApiError } from '../../lib/api';
import { Client, Device, Project, SUBMISSION_TYPE_LABELS, SubmissionType, workspaceApi } from '../../lib/workspaceApi';
import { formValue, useSubmit } from '../auth/useForm';

const CAN_WRITE = new Set(['owner', 'admin', 'editor']);

/** Paged list state with "Load more", reset whenever `key` changes. */
function usePaged<T>(load: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>, key: string) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (next?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await load(next);
        setItems((prev) => (next ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load this list.');
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );

  useEffect(() => {
    setItems([]);
    void fetchPage();
  }, [fetchPage]);

  return {
    items,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore: () => cursor && fetchPage(cursor),
    prepend: (item: T) => setItems((prev) => [item, ...prev]),
  };
}

function LoadMore({ hasMore, loading, onClick }: { hasMore: boolean; loading: boolean; onClick: () => void }): JSX.Element | null {
  if (!hasMore) return null;
  return (
    <button type="button" onClick={onClick} disabled={loading} className="mt-3 text-sm font-semibold text-brand-700 hover:underline">
      {loading ? 'Loading…' : 'Load more'}
    </button>
  );
}

function NewClientForm({ onCreated }: { onCreated: (c: Client) => void }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => workspaceApi(authedRequest), [authedRequest]);
  const { busy, error, run, fieldError } = useSubmit();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const name = formValue(event, 'clientName');
    return run(async () => {
      onCreated(await api.createClient(name));
      form.reset();
    })(event);
  };
  return (
    <form onSubmit={onSubmit} noValidate aria-label="New client">
      <fieldset disabled={busy} className="space-y-3">
        {error && !error.details && <FormMessage tone="error">{error.message}</FormMessage>}
        <Field name="clientName" label="New client name" required error={fieldError('name')} />
        <SubmitButton busy={busy}>Add client</SubmitButton>
      </fieldset>
    </form>
  );
}

function NewDeviceForm({ clientId, onCreated }: { clientId: string; onCreated: (d: Device) => void }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => workspaceApi(authedRequest), [authedRequest]);
  const { busy, error, run, fieldError } = useSubmit();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const models = formValue(event, 'modelNames')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const optional = (k: string) => formValue(event, k).trim() || undefined;
    const body = {
      name: formValue(event, 'deviceName'),
      modelNames: models,
      udiDi: optional('udiDi'),
      productCode: optional('productCode'),
      deviceClass: optional('deviceClass'),
    };
    return run(async () => {
      onCreated(await api.createDevice(clientId, body));
      form.reset();
    })(event);
  };
  return (
    <form onSubmit={onSubmit} noValidate aria-label="New device">
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        {error && !error.details && (
          <div className="sm:col-span-2">
            <FormMessage tone="error">{error.message}</FormMessage>
          </div>
        )}
        <Field name="deviceName" label="Device name" required error={fieldError('name')} />
        <Field name="modelNames" label="Model names (comma separated)" error={fieldError('modelNames')} />
        <Field name="udiDi" label="UDI-DI (optional)" hint="You can add this later." error={fieldError('udiDi')} />
        <Field name="productCode" label="Product code (optional)" maxLength={3} error={fieldError('productCode')} />
        <div>
          <label htmlFor="deviceClass" className="block text-sm font-medium text-slate-800">
            Device class (optional)
          </label>
          <select id="deviceClass" name="deviceClass" defaultValue="" className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2">
            <option value="">Not set</option>
            <option value="I">Class I</option>
            <option value="II">Class II</option>
            <option value="III">Class III</option>
          </select>
        </div>
        <div className="self-end">
          <SubmitButton busy={busy}>Add device</SubmitButton>
        </div>
      </fieldset>
    </form>
  );
}

function NewProjectForm({ devices, onCreated }: { devices: Device[]; onCreated: (p: Project) => void }): JSX.Element {
  const { authedRequest } = useAuth();
  const api = useMemo(() => workspaceApi(authedRequest), [authedRequest]);
  const { busy, error, run, fieldError } = useSubmit();
  if (devices.length === 0) {
    return <p className="text-sm text-slate-600">Add a device first: every submission belongs to one device.</p>;
  }
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const deviceId = formValue(event, 'projectDevice');
    const body = {
      name: formValue(event, 'projectName'),
      submissionType: formValue(event, 'submissionType') as SubmissionType,
      targetDate: formValue(event, 'targetDate') || undefined,
    };
    return run(async () => {
      onCreated(await api.createProject(deviceId, body));
      form.reset();
    })(event);
  };
  return (
    <form onSubmit={onSubmit} noValidate aria-label="New submission">
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        {error && !error.details && (
          <div className="sm:col-span-2">
            <FormMessage tone="error">{error.message}</FormMessage>
          </div>
        )}
        <Field name="projectName" label="Submission name" required error={fieldError('name')} />
        <div>
          <label htmlFor="projectDevice" className="block text-sm font-medium text-slate-800">
            Device
          </label>
          <select id="projectDevice" name="projectDevice" className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2">
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="submissionType" className="block text-sm font-medium text-slate-800">
            Submission type
          </label>
          <select
            id="submissionType"
            name="submissionType"
            defaultValue="traditional"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2"
          >
            {(Object.keys(SUBMISSION_TYPE_LABELS) as SubmissionType[]).map((t) => (
              <option key={t} value={t}>
                {SUBMISSION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <Field name="targetDate" label="Target date (optional)" type="date" error={fieldError('targetDate')} />
        <div className="sm:col-span-2 sm:w-56">
          <SubmitButton busy={busy}>Start submission</SubmitButton>
        </div>
      </fieldset>
    </form>
  );
}

/** Firm > client > project: switch clients and create clients, devices and submissions. */
export default function ClientsPage(): JSX.Element {
  usePageMeta({ title: 'Clients and projects', description: 'Your firm’s clients, devices and 510(k) submissions.' });
  const { session, authedRequest } = useAuth();
  const api = useMemo(() => workspaceApi(authedRequest), [authedRequest]);
  const [params, setParams] = useSearchParams();
  const canWrite = CAN_WRITE.has(session?.role ?? '');

  const clients = usePaged<Client>((c) => api.listClients(c), 'clients');
  const selectedId = params.get('client') ?? clients.items[0]?.id ?? '';
  const selected = clients.items.find((c) => c.id === selectedId);
  const devices = usePaged<Device>(
    (c) => (selectedId ? api.listDevices(selectedId, c) : Promise.resolve({ items: [], nextCursor: null })),
    `d:${selectedId}`
  );
  const projects = usePaged<Project>(
    (c) => (selectedId ? api.listProjects(selectedId, c) : Promise.resolve({ items: [], nextCursor: null })),
    `p:${selectedId}`
  );
  const deviceName = (id: string) => devices.items.find((d) => d.id === id)?.name ?? '';

  return (
    <section className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      <p className="text-sm text-slate-500">
        <Link to="/app" className="hover:underline">
          {session?.org.name}
        </Link>
        {selected && <> › {selected.name}</>}
      </p>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">Clients and projects</h1>
      <p className="mt-1 text-sm text-slate-600">One workspace per client, strictly separated.</p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[18rem_1fr]">
        <aside aria-label="Clients" className="space-y-6">
          <div>
            <label htmlFor="clientSwitcher" className="block text-sm font-semibold text-slate-900">
              Client
            </label>
            {clients.items.length > 0 ? (
              <select
                id="clientSwitcher"
                name="clientSwitcher"
                value={selectedId}
                onChange={(e) => setParams({ client: e.target.value })}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2"
              >
                {clients.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              !clients.loading && <p className="mt-1 text-sm text-slate-600">No clients yet.</p>
            )}
            {clients.error && <FormMessage tone="error">{clients.error}</FormMessage>}
            <LoadMore hasMore={clients.hasMore} loading={clients.loading} onClick={() => void clients.loadMore()} />
          </div>
          {canWrite && (
            <NewClientForm
              onCreated={(c) => {
                clients.prepend(c);
                setParams({ client: c.id });
              }}
            />
          )}
        </aside>

        {selected ? (
          <div className="space-y-8">
            <section aria-labelledby="devices-title" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 id="devices-title" className="text-lg font-semibold text-slate-900">
                Devices
              </h2>
              {devices.items.length === 0 && !devices.loading ? (
                <p className="mt-2 text-sm text-slate-600">No devices for {selected.name} yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100" aria-label="Devices">
                  {devices.items.map((d) => (
                    <li key={d.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
                      <span className="font-medium text-slate-900">{d.name}</span>
                      <span className="text-slate-600">
                        {[
                          d.modelNames.join(', '),
                          d.deviceClass && `Class ${d.deviceClass}`,
                          d.productCode,
                          d.udiDi ? `UDI-DI ${d.udiDi}` : 'No UDI-DI yet',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <LoadMore hasMore={devices.hasMore} loading={devices.loading} onClick={() => void devices.loadMore()} />
              {canWrite && (
                <div className="mt-6 border-t border-slate-100 pt-6">
                  <NewDeviceForm clientId={selected.id} onCreated={devices.prepend} />
                </div>
              )}
            </section>

            <section aria-labelledby="projects-title" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 id="projects-title" className="text-lg font-semibold text-slate-900">
                Submissions
              </h2>
              {projects.items.length === 0 && !projects.loading ? (
                <p className="mt-2 text-sm text-slate-600">No submissions for {selected.name} yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100" aria-label="Submissions">
                  {projects.items.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                      <Link to={`/app/projects/${p.id}`} className="font-medium text-brand-700 hover:underline">
                        {p.name}
                      </Link>
                      <span className="text-slate-600">
                        {SUBMISSION_TYPE_LABELS[p.submissionType]} · {deviceName(p.deviceId) || 'Device'} ·{' '}
                        <span className="capitalize">{p.status}</span>
                        {p.targetDate && ` · target ${p.targetDate}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <LoadMore hasMore={projects.hasMore} loading={projects.loading} onClick={() => void projects.loadMore()} />
              {canWrite && (
                <div className="mt-6 border-t border-slate-100 pt-6">
                  <NewProjectForm devices={devices.items} onCreated={projects.prepend} />
                </div>
              )}
            </section>
          </div>
        ) : (
          !clients.loading && (
            <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-slate-600">
              {canWrite ? 'Add your first client to start a submission.' : 'Ask a firm owner or editor to add a client.'}
            </p>
          )
        )}
      </div>
    </section>
  );
}
