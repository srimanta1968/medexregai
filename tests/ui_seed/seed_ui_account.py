"""
Idempotent seed for UI features that need files the parser has already read.

The BDD runner can navigate, fill, click, select and check text, but it cannot attach a file,
so features that only READ client files (search with citations, the prompt-injection notice)
sign in to this seeded account instead of uploading. Features that test uploading itself
(files.feature, client-requests.feature) are covered by tests/api_definitions/files/* and
requests/* until the runner can upload.

Creates, once, through MedexRegAI's own HTTP APIs:
  account   UI_SEED_EMAIL (default: testCredentials.owner.email) with the password from
            tests/config/test-config.json testCredentials.owner (local test data only)
  client    Northbay Devices, device DC-100 catheter
  projects  DC-100 Traditional 510(k)  with tests/fixtures/ingest/bench-report.docx
            DC-100 Injection check     with tests/fixtures/injection/injected-report.docx
All files are FICTIONAL test data. Re-running changes nothing that already exists.

Run before the UI features:  API_BASE_URL=http://localhost:3000 python tests/ui_seed/seed_ui_account.py
Needs docproc running (the files must be read). Standard library only.
"""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
API = os.environ.get('API_BASE_URL', 'http://localhost:3000').rstrip('/')
CONFIG = json.load(open(os.path.join(ROOT, 'tests', 'config', 'test-config.json'), encoding='utf-8'))
CRED = CONFIG['testCredentials']['owner']
EMAIL = os.environ.get('UI_SEED_EMAIL', CRED['email'])
PASSWORD = os.environ.get('UI_SEED_PASSWORD', CRED['password'])

CLIENT, DEVICE = 'Northbay Devices', 'DC-100 catheter'
PROJECTS = {
    'DC-100 Traditional 510(k)': os.path.join(ROOT, 'tests', 'fixtures', 'ingest', 'bench-report.docx'),
    'DC-100 Injection check': os.path.join(ROOT, 'tests', 'fixtures', 'injection', 'injected-report.docx'),
}


def call(method, path, body=None, token=None):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b'{}')


def data(status, payload, wanted, what):
    if status not in wanted:
        sys.exit(f'{what}: HTTP {status} {(payload.get("error") or {}).get("code")}')
    return payload.get('data')


def sign_in():
    status, payload = call('POST', '/api/auth/login', {'email': EMAIL, 'password': PASSWORD})
    if status == 200:
        return payload['data']['token']
    s = data(*call('POST', '/api/auth/register', {'fullName': 'UI Seed Consultant', 'email': EMAIL, 'password': PASSWORD, 'firmName': 'UI Seed Regulatory'}), (201,), 'register')
    return s['token']


def main():
    token = sign_in()
    clients = data(*call('GET', '/api/clients?limit=50', None, token), (200,), 'clients')
    clients = clients.get('items') if isinstance(clients, dict) else clients
    # The features open the client the switcher selects by default (the newest), so this
    # account must hold no other client. A failed run that typed into the wrong field can add
    # one; clients cannot be deleted, so seed a fresh account instead.
    others = [c['name'] for c in clients if c['name'] != CLIENT]
    if others:
        sys.exit(f'{EMAIL} has other clients ({", ".join(others)}); set UI_SEED_EMAIL and testCredentials.owner.email to a new address')
    client = next((c for c in clients if c['name'] == CLIENT), None)
    if not client:
        client = data(*call('POST', '/api/clients', {'name': CLIENT}, token), (201,), 'client')
    devices = data(*call('GET', f"/api/clients/{client['id']}/devices", None, token), (200,), 'devices')
    device = next((d for d in (devices.get('items') if isinstance(devices, dict) else devices) if d['name'] == DEVICE), None)
    if not device:
        device = data(*call('POST', f"/api/clients/{client['id']}/devices", {'name': DEVICE}, token), (201,), 'device')
    projects = data(*call('GET', f"/api/clients/{client['id']}/projects", None, token), (200,), 'projects')
    projects = projects.get('items') if isinstance(projects, dict) else projects
    for name, path in PROJECTS.items():
        project = next((p for p in projects if p['name'] == name), None)
        if not project:
            project = data(*call('POST', f"/api/devices/{device['id']}/projects", {'name': name, 'submissionType': 'traditional'}, token), (201,), f'project {name}')
        files = data(*call('GET', f"/api/projects/{project['id']}/files?limit=50", None, token), (200,), 'files')
        fname = os.path.basename(path)
        existing = next((f for f in files['items'] if f['name'] == fname), None)
        if not existing:
            existing = data(*call('POST', f"/api/projects/{project['id']}/files", {
                'fileName': fname, 'contentBase64': base64.b64encode(open(path, 'rb').read()).decode('ascii'),
            }, token), (201,), f'upload {fname}')
        for _ in range(60):
            f = data(*call('GET', f"/api/files/{existing['id']}", None, token), (200,), 'file')
            status = (f.get('versions') or [{}])[0].get('parseStatus')
            if status in ('parsed', 'failed', 'unsupported'):
                break
            time.sleep(2)
        if status != 'parsed':
            sys.exit(f'{fname} was not read (parse status {status}); is docproc running?')
        print(f'ok  {name}: {fname} read')


if __name__ == '__main__':
    main()
