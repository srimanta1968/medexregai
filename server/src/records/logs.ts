import { dataService } from '../services/DataService';
import { Block } from '../trust/pdf';

/**
 * F3.4 dated logs for the eQMS: every problem found in the project (contradictions and gaps)
 * with what the consultant decided, and every client request with its items and what arrived.
 */

const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '');
/** Labels for ProblemService.DECISIONS. */
const DECISION: Record<string, string> = {
  note_for_client: 'Note for the client',
  request_data: 'Data requested',
  add_to_request: 'Added to a request',
  accepted: 'Accepted as is',
  dismissed: 'Dismissed',
};

export async function problemLogBlocks(orgId: string, projectId: string): Promise<Block[]> {
  const rows = await dataService.query<{
    kind: string;
    title: string;
    severity: string;
    status: string;
    decision: string | null;
    decision_note: string | null;
    decided_by: string | null;
    decided_at: Date | null;
    created_at: Date;
    still_present: boolean;
    section: string | null;
  }>(
    { orgId },
    'problems',
    `SELECT p.kind, p.title, p.severity, p.status, p.decision, p.decision_note, u.full_name AS decided_by, p.decided_at, p.created_at, p.still_present, s.title AS section
       FROM problems p LEFT JOIN user_profiles u ON u.user_id = p.decided_by LEFT JOIN estar_sections s ON s.id = p.section_id
      WHERE p.org_id = $1 AND p.project_id = $2 ORDER BY p.created_at, p.title`,
    [orgId, projectId],
  );
  const open = rows.filter((r) => r.status === 'open' && r.still_present).length;
  return [
    { kind: 'h2', text: 'Problems' },
    { kind: 'p', text: `${rows.length} problem(s) found in this project, ${open} still open. Each row shows when it was found and what was decided, by whom and when.` },
    rows.length
      ? {
          kind: 'table',
          columns: [
            { label: 'Found', width: 1 },
            { label: 'Problem', width: 3 },
            { label: 'Kind', width: 1.1 },
            { label: 'Severity', width: 0.9 },
            { label: 'Status', width: 0.9 },
            { label: 'Decision', width: 2.6 },
          ],
          rows: rows.map((r) => [
            day(r.created_at),
            `${r.title}${r.section ? ` (${r.section})` : ''}`,
            r.kind,
            r.severity,
            r.status === 'open' && !r.still_present ? 'no longer found' : r.status,
            r.decision
              ? `${DECISION[r.decision] ?? r.decision}${r.decided_by ? ` by ${r.decided_by}` : ''}${r.decided_at ? `, ${day(r.decided_at)}` : ''}${r.decision_note ? `: ${r.decision_note}` : ''}`
              : '',
          ]),
        }
      : { kind: 'p', text: 'No problems have been found.' },
  ];
}

export async function requestLogBlocks(orgId: string, projectId: string): Promise<Block[]> {
  const requests = await dataService.query<{
    id: string;
    title: string;
    status: string;
    recipient_name: string | null;
    recipient_email: string | null;
    created_at: Date;
    approved_at: Date | null;
    approved_by: string | null;
    emailed_at: Date | null;
    closed_at: Date | null;
  }>(
    { orgId },
    'client_requests',
    `SELECT r.id, r.title, r.status, r.recipient_name, r.recipient_email, r.created_at, r.approved_at, u.full_name AS approved_by, r.emailed_at, r.closed_at
       FROM client_requests r LEFT JOIN user_profiles u ON u.user_id = r.approved_by
      WHERE r.org_id = $1 AND r.project_id = $2 ORDER BY r.created_at`,
    [orgId, projectId],
  );
  const items = await dataService.query<{ request_id: string; position: number; label: string; status: string; received_at: Date | null; received_count: number }>(
    { orgId },
    'client_request_items',
    `SELECT i.request_id, i.position, i.label, i.status, i.received_at, i.received_count FROM client_request_items i
       JOIN client_requests r ON r.id = i.request_id AND r.org_id = i.org_id
      WHERE i.org_id = $1 AND r.project_id = $2 ORDER BY i.request_id, i.position`,
    [orgId, projectId],
  );
  const blocks: Block[] = [{ kind: 'h2', text: 'Client requests' }];
  if (!requests.length) return [...blocks, { kind: 'p', text: 'No requests have been made to the client.' }];
  blocks.push({ kind: 'p', text: `${requests.length} request(s); ${items.filter((i) => i.status === 'received').length} of ${items.length} item(s) received.` });
  for (const r of requests) {
    blocks.push({ kind: 'h3', text: r.title });
    blocks.push({
      kind: 'fields',
      rows: [
        ['Status', r.status],
        ['To', [r.recipient_name, r.recipient_email].filter(Boolean).join(', ')],
        ['Drafted', day(r.created_at)],
        ['Approved', r.approved_at ? `${day(r.approved_at)}${r.approved_by ? ` by ${r.approved_by}` : ''}` : 'not yet'],
        ['Emailed', day(r.emailed_at) || 'not sent'],
        ['Closed', day(r.closed_at) || 'open'],
      ],
    });
    const mine = items.filter((i) => i.request_id === r.id);
    if (mine.length) {
      blocks.push({
        kind: 'table',
        columns: [
          { label: '#', width: 0.4 },
          { label: 'Item', width: 4 },
          { label: 'Status', width: 1 },
          { label: 'Received', width: 1.2 },
          { label: 'Files', width: 0.6 },
        ],
        rows: mine.map((i) => [String(i.position), i.label, i.status, day(i.received_at), String(i.received_count)]),
      });
    }
  }
  return blocks;
}
