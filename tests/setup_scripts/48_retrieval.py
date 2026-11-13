# @fixture scope=tenant tier=api reason="ranked retrieval and the citation gate need a client file that the parser has read into located passages, in a fresh firm, so each session makes one through the app's own APIs"
# @exports rt_token, rt_project_id, rt_citation, rt_query
"""
Provision, through MedexRegAI's own HTTP APIs, a project for F7.3 retrieval and the citation gate:

  rt_token / rt_project_id   owner and project with two FICTIONAL reports: an EO residuals report
                             and an unrelated packaging report
  rt_query                   a query only the EO report answers
  rt_citation                the citation marker ([C:<version>#<location>]) of the top search hit

Asserts, before exporting, what the definitions cannot (arrays): the top hit for rt_query is the
EO report, it carries a source location and a 'where', and its citation resolves.

Needs docproc running (files must be read). Standard library only.
"""

import base64
import importlib.util
import json
import os
import secrets
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect, source_docx, wait_parsed = fx.call, fx.expect, fx.source_docx, fx.wait_parsed

OUT = os.environ.get('SETUP_VARS_OUT')
QUERY = 'ethylene chlorohydrin residual'

EO_REPORT = [
    'EO-21 Ethylene Oxide Residuals Test Report (FICTIONAL TEST DATA)',
    'Residuals were evaluated in accordance with ISO 10993-7:2008.',
    'Ethylene chlorohydrin residual was measured on three devices after aeration.',
    'All acceptance criteria were met.',
]
PACK_REPORT = [
    'PK-04 Packaging Seal Strength Report (FICTIONAL TEST DATA)',
    'Seal strength was tested per ASTM F88 on thirty pouches.',
    'All pouches met the minimum peel strength.',
]


def upload(token, project_id, name, paragraphs):
    f = expect(*call('POST', f'/api/projects/{project_id}/files', {
        'fileName': name, 'contentBase64': base64.b64encode(source_docx(paragraphs)).decode('ascii'),
    }, token), 201, f'upload {name}')
    wait_parsed(token, f['id'])
    return f['id']


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Fixture Retrieval Owner', 'email': f'fixture-retrieval-{secrets.token_hex(6)}@example.test',
        'password': fx.PASSWORD, 'firmName': f'Fixture Retrieval Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    client = expect(*call('POST', '/api/clients', {'name': f'Northbay Devices {secrets.token_hex(3)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set'}, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Traditional 510(k)', 'submissionType': 'traditional'}, token), 201, 'project')
    eo_id = upload(token, project['id'], 'EO-21 residuals report.docx', EO_REPORT)
    upload(token, project['id'], 'PK-04 seal strength report.docx', PACK_REPORT)

    res = expect(*call('GET', f"/api/projects/{project['id']}/search?q={urllib.parse.quote(QUERY)}&limit=5", None, token), 200, 'search')
    items = res.get('items') or []
    if not items:
        sys.exit(f'search for {QUERY!r} returned nothing')
    top = items[0]
    if top['fileId'] != eo_id:
        sys.exit(f"top hit is {top['fileName']}, expected the EO report")
    if not top.get('start') or not top.get('where') or not str(top.get('citation', '')).startswith('[C:'):
        sys.exit(f'top hit has no source location or citation: {top}')
    if any(i['fileId'] != eo_id for i in items[:1]) or (len(items) > 1 and items[0].get('score', 0) < items[-1].get('score', 0)):
        sys.exit('hits are not ranked best first')

    values = {'rt_token': token, 'rt_project_id': project['id'], 'rt_citation': top['citation'], 'rt_query': QUERY}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
