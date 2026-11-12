# @fixture scope=tenant tier=api reason="usage counts need a client file actually read by the parser, in a fresh firm whose numbers nothing else touches, so each session makes one through the app's own APIs"
# @exports usage_token, usage_workspace_id, usage_empty_workspace_id, usage_from, usage_to
"""
Provision, through MedexRegAI's own HTTP APIs, a firm for F4.3 usage:

  usage_token               owner of a fresh firm
  usage_workspace_id        client "Northbay Devices" with one project and one file read by the
                            parser (a FICTIONAL test report built here): 1 file read, 0 drafts
  usage_empty_workspace_id  client "Quiet Client" with one project and nothing read (all zeros)
  usage_from / usage_to     yesterday and tomorrow (UTC dates) around the read

Needs docproc running (the file must be parsed). Standard library only.
"""

import base64
import importlib.util
import json
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect, source_docx, wait_parsed = fx.call, fx.expect, fx.source_docx, fx.wait_parsed

OUT = os.environ.get('SETUP_VARS_OUT')

REPORT = [
    'EO-21 Ethylene Oxide Residuals Test Report',
    'Residuals were evaluated in accordance with ISO 10993-7:2008.',
    'All acceptance criteria were met.',
]


def client_with_project(token, name):
    client = expect(*call('POST', '/api/clients', {'name': f'{name} {secrets.token_hex(3)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set'}, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Traditional 510(k)', 'submissionType': 'traditional'}, token), 201, 'project')
    return client['id'], project['id']


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Fixture Usage Owner',
        'email': f'fixture-usage-{secrets.token_hex(6)}@example.test',
        'password': fx.PASSWORD,
        'firmName': f'Fixture Usage Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    workspace_id, project_id = client_with_project(token, 'Northbay Devices')
    empty_workspace_id, _ = client_with_project(token, 'Quiet Client')

    upload = expect(*call('POST', f'/api/projects/{project_id}/files', {
        'fileName': 'EO-21 residuals report.docx',
        'contentBase64': base64.b64encode(source_docx(REPORT)).decode('ascii'),
    }, token), 201, 'upload')
    wait_parsed(token, upload['id'])

    now = datetime.now(timezone.utc)
    frm = (now - timedelta(days=1)).date().isoformat()
    to = (now + timedelta(days=1)).date().isoformat()
    usage = expect(*call('GET', f'/api/usage?from={frm}&to={to}', None, token), 200, 'usage')
    if usage['totals']['filesRead'] != 1 or usage['totals']['draftsGenerated'] != 0 or len(usage['clients']) != 2:
        sys.exit(f"usage: {usage['totals']} over {len(usage['clients'])} clients; expected 1 file read, 0 drafts, 2 clients")

    values = {'usage_token': token, 'usage_workspace_id': workspace_id, 'usage_empty_workspace_id': empty_workspace_id, 'usage_from': frm, 'usage_to': to}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
