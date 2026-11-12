# @fixture scope=tenant tier=api reason="pilot metrics need a firm baseline and time logged on a project with known hours, so each session makes a fresh firm through the app's own APIs"
# @exports pilot_token, pilot_project_id, pilot_empty_project_id
"""
Provision, through MedexRegAI's own HTTP APIs, a firm for the F4.2 pilot report:

  pilot_token             owner of a fresh firm whose baseline is 88 h (chase 10, find 8,
                          version 4, map 6, trace 3, read 12, reconcile 6, tabulate 8,
                          write 16, forms 4, attachments 5, client review 6)
  pilot_project_id        a project with 20 h logged last week: write 8, tabulate 4,
                          reconcile 2, chase 6 -> whole project 77% below the baseline
                          (target 25%), drafted sections 14 h vs 30 h, 53% below (target 30%);
                          no draft re-imported yet, so no acceptance rate
  pilot_empty_project_id  a second project with no time logged

Standard library only.
"""

import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

API = (os.environ.get('API_BASE_URL') or 'http://localhost:3000').rstrip('/')
OUT = os.environ.get('SETUP_VARS_OUT')
PASSWORD = 'Fx-' + secrets.token_urlsafe(18)

BASELINE = {'chase': 10, 'find': 8, 'version': 4, 'map': 6, 'trace': 3, 'read': 12, 'reconcile': 6, 'tabulate': 8, 'write': 16, 'forms': 4, 'attachments': 5, 'client_review': 6}
LOGGED = [('write', 8), ('tabulate', 4), ('reconcile', 2), ('chase', 6)]


def call(method, path, body=None, token=None):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b'{}')


def expect(status, payload, wanted, what):
    if status != wanted:
        code = (payload.get('error') or {}).get('code') if isinstance(payload, dict) else None
        sys.exit(f'{what}: expected {wanted}, got {status} {code}')
    return payload['data']


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Fixture Pilot Lead',
        'email': f'fixture-pilot-{secrets.token_hex(6)}@example.test',
        'password': PASSWORD,
        'firmName': f'Fixture Pilot Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    client = expect(*call('POST', '/api/clients', {'name': f'Fixture Client {secrets.token_hex(4)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set'}, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Traditional 510(k)', 'submissionType': 'traditional'}, token), 201, 'project')
    empty = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Special 510(k)', 'submissionType': 'special'}, token), 201, 'second project')
    expect(*call('PUT', '/api/pilot/baseline', {'basis': 'Traditional 510(k), infusion set, 2025 (fixture)', 'hours': BASELINE}, token), 200, 'baseline')

    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    start = today - timedelta(days=today.weekday() + 7) + timedelta(hours=8)
    for i, (code, hours) in enumerate(LOGGED):
        begin = start + timedelta(days=i)
        expect(*call('POST', '/api/time/entries', {'activityCode': code, 'projectId': project['id'], 'startedAt': iso(begin), 'endedAt': iso(begin + timedelta(hours=hours))}, token), 201, f'{code} entry')

    report = expect(*call('GET', f"/api/projects/{project['id']}/pilot-report", None, token), 200, 'report')
    if report['wholeProject']['actualHours'] != 20 or report['wholeProject']['reduction'] != 0.77 or report['draftedSections']['reduction'] != 0.53:
        sys.exit(f"pilot report: {report['wholeProject']} {report['draftedSections']}; expected 20 h, 77% and 53% lower")

    values = {'pilot_token': token, 'pilot_project_id': project['id'], 'pilot_empty_project_id': empty['id']}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
