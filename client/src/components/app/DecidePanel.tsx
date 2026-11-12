import { FormEvent, useState } from 'react';
import { Decision, ProblemDetail } from '../../lib/problemsApi';

const button = 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:border-brand-400 disabled:opacity-60';
const primary = 'rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60';

/** The choices of UI 2.0 §4.3, worded for which side is at fault; dismiss is always last. */
function options(problem: ProblemDetail): { value: Decision; label: string; hint: string }[] {
  const [a, b] = problem.sources;
  const first = a ? a.fileName : 'the first document';
  const second = b ? b.fileName : 'the evidence';
  return problem.kind === 'contradiction'
    ? [
        { value: 'note_for_client', label: `${first} is wrong: note for client`, hint: 'Recorded for the client; nothing is sent until you send a request.' },
        { value: 'request_data', label: `${second} is incomplete: request data`, hint: 'Adds an item to the draft client request.' },
        { value: 'accepted', label: 'Accept with reason', hint: 'Both stand; your reason is kept in the project record.' },
        { value: 'add_to_request', label: 'Add to client request', hint: 'Asks the client to clear it up, through the draft request.' },
        { value: 'dismissed', label: 'Not a problem: dismiss', hint: 'For a false alarm; your note is kept.' },
      ]
    : [
        { value: 'add_to_request', label: 'Ask the client: add to client request', hint: 'Adds the missing evidence to the draft client request.' },
        { value: 'accepted', label: 'Accept with reason', hint: 'For example, why the section does not apply to this device.' },
        { value: 'note_for_client', label: 'Note for client', hint: 'Recorded for the client.' },
        { value: 'dismissed', label: 'Not a problem: dismiss', hint: 'For a false alarm; your note is kept.' },
      ];
}

/**
 * F2.3 Decide panel: the consultant picks what to do about a problem and says why.
 * The note is required; the decision and reason are kept in the project record.
 */
export function DecidePanel({ problem, busy, onDecide }: { problem: ProblemDetail; busy: boolean; onDecide: (decision: Decision, note: string) => void }): JSX.Element {
  const [decision, setDecision] = useState<Decision | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!decision) return setError('Pick what to do.');
    if (note.trim().length < 3) return setError('Add a short note explaining the decision.');
    setError(undefined);
    onDecide(decision, note.trim());
  };
  return (
    <form className="mt-5 rounded-xl border border-slate-200 p-4" onSubmit={submit} noValidate aria-labelledby="decide-title">
      <h3 id="decide-title" className="text-sm font-semibold text-slate-900">
        Decide
      </h3>
      <fieldset className="mt-2 space-y-1 text-sm">
        <legend className="sr-only">What to do</legend>
        {options(problem).map((o) => (
          <label key={o.value} className="flex items-start gap-2">
            <input type="radio" name="decision" value={o.value} checked={decision === o.value} onChange={() => setDecision(o.value)} className="mt-1" />
            <span>
              <span className="text-slate-900">{o.label}</span>
              <span className="block text-xs text-slate-500">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="mt-3 block text-sm">
        <span className="font-medium text-slate-900">Reason</span>
        <textarea
          name="decisionNote"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'decide-error' : 'decide-help'}
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5"
        />
      </label>
      <p id="decide-help" className="mt-1 text-xs text-slate-500">
        Your decision and reason are kept in the project record.
      </p>
      {error && (
        <p id="decide-error" role="alert" className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button type="submit" className={primary} disabled={busy}>
          Save decision
        </button>
        <button type="button" className={button} disabled={busy} onClick={() => (setDecision(''), setNote(''), setError(undefined))}>
          Clear
        </button>
      </div>
    </form>
  );
}
