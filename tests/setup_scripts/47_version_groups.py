# @fixture scope=tenant tier=api reason="a version group exists only after two revisions of the same document have been read and grouped, in a fresh firm, so each session makes one through the app's own APIs"
# @exports vg_token, vg_project_id, vg_group_id, vg_file_id
"""
Provision, through MedexRegAI's own HTTP APIs, a project with one version group (F2.2):

  vg_token        owner of a fresh firm
  vg_project_id   project with "SL-22 ageing report rev A.docx" and "... rev B.docx"
                  (FICTIONAL test data), grouped as two revisions of one document
  vg_group_id     that group
  vg_file_id      rev A, so confirming it as current is a real decision (rev B is the automatic pick)

Needs docproc running (files must be read). Standard library only.
"""

import base64
import importlib.util
import json
import os
import secrets
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect, source_docx, wait_parsed = fx.call, fx.expect, fx.source_docx, fx.wait_parsed

OUT = os.environ.get('SETUP_VARS_OUT')


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Fixture Versions Owner', 'email': f'fixture-versions-{secrets.token_hex(6)}@example.test',
        'password': fx.PASSWORD, 'firmName': f'Fixture Versions Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    client = expect(*call('POST', '/api/clients', {'name': f'Northbay Devices {secrets.token_hex(3)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set'}, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Traditional 510(k)', 'submissionType': 'traditional'}, token), 201, 'project')

    ids = {}
    for rev, months in (('A', 6), ('B', 12)):
        f = expect(*call('POST', f"/api/projects/{project['id']}/files", {
            'fileName': f'SL-22 ageing report rev {rev}.docx',
            'contentBase64': base64.b64encode(source_docx([
                f'SL-22 Accelerated Ageing Report, revision {rev} (FICTIONAL TEST DATA)',
                f'Samples aged to an equivalent of {months} months per ASTM F1980.',
            ])).decode('ascii'),
        }, token), 201, f'upload rev {rev}')
        wait_parsed(token, f['id'])
        ids[rev] = f['id']

    group = None
    for _ in range(30):
        groups = expect(*call('GET', f"/api/projects/{project['id']}/version-groups", None, token), 200, 'version groups')
        group = next((g for g in groups if {m['fileId'] for m in g['members']} >= set(ids.values())), None)
        if group:
            break
        time.sleep(2)
    if not group:
        sys.exit('the two revisions were not grouped (is the worker running?)')

    values = {'vg_token': token, 'vg_project_id': project['id'], 'vg_group_id': group['id'], 'vg_file_id': ids['A']}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
