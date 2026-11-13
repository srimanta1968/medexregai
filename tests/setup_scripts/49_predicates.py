# @fixture scope=tenant tier=api reason="predicate similarity needs the subject device's indications and description read from a client file, in a fresh firm, so each session makes them through the app's own APIs"
# @exports pr_token, pr_project_id, pr_k_number, pr_comparison_id, pr_delete_comparison_id, pr_create_k_number
"""
Provision, through MedexRegAI's own HTTP APIs, a project for F5.2 predicate search:

  pr_token / pr_project_id   owner and project; the device IS-200 infusion set has product code FPA
                             and the project holds one read FICTIONAL file with its indications for
                             use and device description
  pr_k_number                a clearance found by semantic search whose 510(k) summary is indexed
                             (so similarity is computed), for the SE table builder

Asserts what the definitions cannot (arrays) on real FDA data from the fda-data service:
every candidate with a linked recall is 'recall_linked', never 'clean', and similarity is
computed for at least one candidate.

Needs docproc and the fda-data service running. Standard library only.
"""

import base64
import importlib.util
import json
import os
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect, source_docx, wait_parsed = fx.call, fx.expect, fx.source_docx, fx.wait_parsed

OUT = os.environ.get('SETUP_VARS_OUT')

SUBJECT = [
    'IS-200 Infusion Set: Indications for Use and Device Description (FICTIONAL TEST DATA)',
    'Indications for Use: The IS-200 infusion set is intended for the administration of intravenous fluids '
    'and medications from a container to the vascular system of a patient by gravity or with an infusion pump.',
    'Device Description: The IS-200 is a single-use, sterile administration set consisting of a spike, a drip '
    'chamber, PVC tubing, a roller clamp, a needle-free Y-site and a male luer lock connector. It is sterilized '
    'with ethylene oxide.',
]


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Fixture Predicates Owner', 'email': f'fixture-predicates-{secrets.token_hex(6)}@example.test',
        'password': fx.PASSWORD, 'firmName': f'Fixture Predicates Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    client = expect(*call('POST', '/api/clients', {'name': f'Northbay Devices {secrets.token_hex(3)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set', 'productCode': 'FPA', 'deviceClass': 'II'}, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Traditional 510(k)', 'submissionType': 'traditional'}, token), 201, 'project')
    f = expect(*call('POST', f"/api/projects/{project['id']}/files", {
        'fileName': 'IS-200 indications and description.docx', 'contentBase64': base64.b64encode(source_docx(SUBJECT)).decode('ascii'),
    }, token), 201, 'upload')
    wait_parsed(token, f['id'])

    # Semantic search finds 510(k)s whose summaries are already indexed in fda-data (summaries are
    # fetched over time for tracked product codes), so similarity can be computed for them.
    k_number, computed, cursor = None, False, None
    for query in ('catheter for vascular access', 'infusion administration set tubing'):
        path = f"/api/projects/{project['id']}/predicates/search?mode=semantic&limit=10&q={query.replace(' ', '%20')}"
        page = expect(*call('GET', path, None, token), 200, 'predicate search')
        for c in page['items']:
            if (c['flags']['recalls'] or 0) > 0 and c['flags']['status'] != 'recall_linked':
                sys.exit(f"{c['kNumber']} has {c['flags']['recalls']} recall(s) but is shown as {c['flags']['status']}")
            if c['flags']['status'] == 'clean' and (c['flags']['recalls'] is None):
                sys.exit(f"{c['kNumber']} is clean although its recalls could not be checked")
            if c['similarity']['ifu'] != 'unknown' or c['similarity']['tech'] != 'unknown':
                computed = True
                k_number = k_number or c['kNumber']
        if k_number:
            break
    # Flag ranking: once a recall-linked candidate appears, no clean one follows it.
    page = expect(*call('GET', f"/api/projects/{project['id']}/predicates/search?mode=keyword&q=infusion%20pump&limit=10", None, token), 200, 'keyword search')
    statuses = [c['flags']['status'] for c in page['items']]
    for c in page['items']:
        if (c['flags']['recalls'] or 0) > 0 and c['flags']['status'] != 'recall_linked':
            sys.exit(f"{c['kNumber']} has recalls but is shown as {c['flags']['status']}")
    if 'recall_linked' in statuses and 'clean' in statuses[statuses.index('recall_linked'):]:
        sys.exit(f'a clean candidate is ranked below a recall-linked one: {statuses}')

    if not computed:
        sys.exit('no candidate had a computed similarity (are 510(k) summaries indexed in fda-data?)')

    # SE comparisons: one built against the summary-indexed predicate (for get, edit, rebuild and
    # export), one to delete; a third K-number from the keyword page is left for the create case.
    others = [c['kNumber'] for c in page['items'] if c['kNumber'] != k_number]
    if len(others) < 2:
        sys.exit('the keyword search returned too few candidates for the comparison cases')
    comparison = expect(*call('POST', f"/api/projects/{project['id']}/se-comparisons", {'kNumber': k_number}, token), 201, 'SE comparison')
    by_key = {r['key']: r for r in comparison['rows']}
    if by_key['product_code']['comparison'] not in ('same', 'different') or by_key['indications']['comparison'] != 'review':
        sys.exit('structured rows must be compared and text rows left for review')
    if not any(c.get('marker', '').startswith('[R:') for r in comparison['rows'] for c in r['predicate']['citations'] if c.get('marker')):
        sys.exit('no predicate cell cites the 510(k) summary')
    if not any((c.get('marker') or '').startswith('[C:') for r in comparison['rows'] for c in r['subject']['citations']):
        sys.exit("no subject cell cites the client's files")
    doomed = expect(*call('POST', f"/api/projects/{project['id']}/se-comparisons", {'kNumber': others[0]}, token), 201, 'SE comparison to delete')

    values = {'pr_token': token, 'pr_project_id': project['id'], 'pr_k_number': k_number, 'pr_comparison_id': comparison['id'],
              'pr_delete_comparison_id': doomed['id'], 'pr_create_k_number': others[1]}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
