# @fixture scope=tenant tier=api reason="readiness checks need a project whose filed attachments break eSTAR's name and type rules; made per session through the app's own APIs"
# @exports readiness_token, readiness_project_id
"""
Provision, through MedexRegAI's own HTTP APIs, a project whose filed attachments trip the
F3.4 eSTAR checks:

  readiness_token       owner of a fresh firm (Bearer token)
  readiness_project_id  a project with three files filed under eSTAR sections:
                          - a PDF whose name is 125 characters (over FDA's 124 limit)
                          - raw-data.zip (zip files are rejected by eSTAR)
                          - a short, valid PDF name
                        Sizes are tiny: the 1 GB and 4 GB limits are covered by the checker's
                        boundary logic, not by uploading gigabytes.

Fresh random names every run. Standard library only.
"""

import base64
import json
import os
import secrets
import sys
import urllib.error
import urllib.request

API = (os.environ.get('API_BASE_URL') or 'http://localhost:3000').rstrip('/')
OUT = os.environ.get('SETUP_VARS_OUT')
PASSWORD = 'Fx-' + secrets.token_urlsafe(18)
TINY_PDF = b'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'


def call(method, path, body=None, token=None):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b'{}')


def expect(status, payload, wanted, what):
    if status != wanted:
        sys.exit(f"{what}: expected {wanted}, got {status} {(payload.get('error') or {}).get('code')}")
    return payload['data']


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Fixture Readiness',
        'email': f'fixture-readiness-{secrets.token_hex(6)}@example.test',
        'password': PASSWORD,
        'firmName': f'Fixture Readiness Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    client = expect(*call('POST', '/api/clients', {'name': f'Fixture Client {secrets.token_hex(4)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set'}, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Traditional 510(k)', 'submissionType': 'traditional'}, token), 201, 'project')

    long_name = ('EO-09 ethylene oxide sterilization validation report for the IS-200 infusion set including residuals and BI results rev ' + 'A' * 30)[:121] + '.pdf'
    assert len(long_name) == 125
    files = [
        (long_name, TINY_PDF, 'sterility'),
        ('raw-data.zip', b'PK\x05\x06' + b'\x00' * 18, 'performance_testing'),
        ('BC-114 biocompatibility.pdf', TINY_PDF, 'biocompatibility'),
    ]
    for name, data, section in files:
        f = expect(*call('POST', f"/api/projects/{project['id']}/files", {'fileName': name, 'contentBase64': base64.b64encode(data).decode('ascii')}, token), 201, f'upload {name}')
        expect(*call('PUT', f"/api/files/{f['id']}/assignment", {'sectionId': section}, token), 200, f'assign {name}')

    values = {'readiness_token': token, 'readiness_project_id': project['id']}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps({k: v[:40] for k, v in values.items()}))


if __name__ == '__main__':
    main()
