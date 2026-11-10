import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Field, FormMessage, SubmitButton } from '../../components/auth/AuthUi';
import { usePageMeta } from '../../hooks/usePageMeta';
import { formValue, useSubmit } from '../auth/useForm';

interface OpenInvite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

const INVITABLE_ROLES = ['reviewer', 'editor', 'viewer', 'admin'] as const;
const CAN_INVITE = new Set(['owner', 'admin']);

/** Firm settings > Users and roles: invite a teammate and see pending invitations. */
function TeamPanel(): JSX.Element {
  const { authedRequest } = useAuth();
  const { busy, error, run, fieldError } = useSubmit();
  const [invites, setInvites] = useState<OpenInvite[]>([]);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const load = useCallback(async () => {
    const page = await authedRequest<{ items: OpenInvite[] }>('/api/invites?limit=50');
    setInvites(page.items);
  }, [authedRequest]);

  useEffect(() => {
    load().catch(() => setInvites([]));
  }, [load]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const email = formValue(event, 'inviteEmail');
    const role = formValue(event, 'inviteRole');
    return run(async () => {
      setSentTo(null);
      await authedRequest('/api/invites', { method: 'POST', body: { email, role } });
      form.reset();
      setSentTo(email);
      await load();
    })(event);
  };

  return (
    <section aria-labelledby="team-title" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 id="team-title" className="text-lg font-semibold text-slate-900">
        Users and roles
      </h2>
      <p className="mt-1 text-sm text-slate-600">Invite a colleague or an outside reviewer. The invitation link is valid for 7 days.</p>

      <form className="mt-6 grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end" onSubmit={onSubmit} noValidate>
        <Field name="inviteEmail" label="Email address" type="email" autoComplete="off" required error={fieldError('email')} />
        <div>
          <label htmlFor="inviteRole" className="block text-sm font-medium text-slate-800">
            Role
          </label>
          <select id="inviteRole" name="inviteRole" defaultValue="reviewer" className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 capitalize">
            {INVITABLE_ROLES.map((r) => (
              <option key={r} value={r} className="capitalize">
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:w-40">
          <SubmitButton busy={busy}>Send invitation</SubmitButton>
        </div>
      </form>
      <div className="mt-4 space-y-2">
        {error && !error.details && <FormMessage tone="error">{error.message}</FormMessage>}
        {sentTo && <FormMessage tone="success">Invitation sent to {sentTo}.</FormMessage>}
      </div>

      <h3 className="mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">Pending invitations</h3>
      {invites.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">No pending invitations.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100" aria-label="Pending invitations">
          {invites.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
              <span className="font-medium text-slate-900">{i.email}</span>
              <span className="capitalize text-slate-600">
                {i.role} · expires {new Date(i.expiresAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function WorkspacePage(): JSX.Element {
  usePageMeta({ title: 'Workspace', description: 'Your MedexRegAI firm workspace.' });
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  if (!session) {
    return <></>;
  }

  const onSignOut = async (): Promise<void> => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <section className="mx-auto w-full max-w-4xl flex-1 space-y-8 px-4 py-12 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{session.org.name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Signed in as {session.user.fullName} ({session.user.email}) · <span className="capitalize">{session.role}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
        >
          Sign out
        </button>
      </div>
      <Link
        to="/app/clients"
        className="block rounded-2xl border border-slate-200 bg-white p-6 shadow-sm hover:border-brand-300"
      >
        <span className="text-lg font-semibold text-brand-700">Clients and projects</span>
        <span className="mt-1 block text-sm text-slate-600">Switch client, add devices and start 510(k) submissions.</span>
      </Link>
      {CAN_INVITE.has(session.role) ? (
        <TeamPanel />
      ) : (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          Ask a firm owner or admin to invite more people.
        </p>
      )}
    </section>
  );
}
