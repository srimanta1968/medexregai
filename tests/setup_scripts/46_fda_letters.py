# @fixture scope=tenant tier=api reason="a letter's deficiencies link to client files that the parser has read, in a fresh firm whose letters nothing else touches, so each session makes them through the app's own APIs"
# @exports fl_token, fl_project_id, fl_other_project_id, fl_file_id, fl_other_file_id, fl_letter_id, fl_deficiency_id, fl_delete_letter_id, fl_letter_file_version_id
"""
Provision, through MedexRegAI's own HTTP APIs, a firm for F5.1 FDA letters:

  fl_token                    owner of a fresh firm
  fl_project_id               project with one read client file (fl_file_id, a FICTIONAL EO
                              residuals report) and one read letter file (fl_letter_file_version_id,
                              a FICTIONAL Additional Information letter, clearly marked as not from FDA)
  fl_other_project_id         a second project of the same firm, with fl_other_file_id
  fl_letter_id                an AI request letter (issued 2026-06-02, due 2026-11-29) with
                              deficiencies 1 and 2; fl_deficiency_id is deficiency 1
  fl_delete_letter_id         a second letter, for the delete case

Needs docproc running (files must be parsed). Standard library only.
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

REPORT = [
    'EO-21 Ethylene Oxide Residuals Test Report (FICTIONAL TEST DATA)',
    'EO residuals were evaluated in accordance with ISO 10993-7:2008.',
    'ECH residuals were not tested.',
]
LETTER = [
    'FICTIONAL TEST LETTER - NOT FROM FDA',
    'June 2, 2026',
    'Re: K269999',
    'We need the following additional information.',
    '1. Please provide ECH residual results for the EO sterilized device per ISO 10993-7.',
    '2. Please provide the full cytotoxicity report referenced in your biocompatibility summary.',
    'If you have any questions about this letter, please contact the lead reviewer.',
]


def upload(token, project_id, name, paragraphs):
    f = expect(*call('POST', f'/api/projects/{project_id}/files', {
        'fileName': name, 'contentBase64': base64.b64encode(source_docx(paragraphs)).decode('ascii'),
    }, token), 201, f'upload {name}')
    wait_parsed(token, f['id'])
    detail = expect(*call('GET', f"/api/files/{f['id']}", None, token), 200, f'file {name}')
    return f['id'], detail.get('currentVersionId') or detail['versions'][0]['id']


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Fixture Letters Owner', 'email': f'fixture-letters-{secrets.token_hex(6)}@example.test',
        'password': fx.PASSWORD, 'firmName': f'Fixture Letters Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    client = expect(*call('POST', '/api/clients', {'name': f'Northbay Devices {secrets.token_hex(3)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set'}, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Traditional 510(k)', 'submissionType': 'traditional'}, token), 201, 'project')
    other = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Special 510(k)', 'submissionType': 'special'}, token), 201, 'other project')

    file_id, _ = upload(token, project['id'], 'EO-21 residuals report.docx', REPORT)
    _, letter_version = upload(token, project['id'], 'FDA AI letter K269999.docx', LETTER)
    other_file_id, _ = upload(token, other['id'], 'Other project report.docx', REPORT)

    letter = expect(*call('POST', f"/api/projects/{project['id']}/fda-letters", {
        'kind': 'ai_request', 'fdaReference': 'K269999', 'issuedOn': '2026-06-02', 'fileVersionId': letter_version,
        'deficiencies': [
            {'number': 1, 'summary': 'Provide ECH residual results', 'fdaText': LETTER[4][3:], 'sectionId': 'sterility', 'fileIds': [file_id]},
            {'number': 2, 'summary': 'Provide the full cytotoxicity report', 'fdaText': LETTER[5][3:], 'owner': 'client'},
        ],
    }, token), 201, 'letter')
    if letter['dueOn'] != '2026-11-29' or len(letter['deficiencies']) != 2:
        sys.exit(f"letter: due {letter['dueOn']}, {len(letter['deficiencies'])} deficiencies; expected 2026-11-29 and 2")
    second = expect(*call('POST', f"/api/projects/{project['id']}/fda-letters", {
        'kind': 'rta_hold', 'issuedOn': '2026-05-01', 'deficiencies': [{'number': 1, 'summary': 'Missing eSTAR attachment', 'fdaText': 'Attach the labeling.'}],
    }, token), 201, 'second letter')

    values = {
        'fl_token': token, 'fl_project_id': project['id'], 'fl_other_project_id': other['id'], 'fl_file_id': file_id,
        'fl_other_file_id': other_file_id, 'fl_letter_id': letter['id'], 'fl_deficiency_id': letter['deficiencies'][0]['id'],
        'fl_delete_letter_id': second['id'], 'fl_letter_file_version_id': letter_version,
    }
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
