# @fixture scope=tenant tier=api reason="time totals need entries in a known past week and timers in known states, each owned by its own person, so each session makes three fresh firms through the app's own APIs"
# @exports time_week_end, time_manual_start, time_manual_end, time_token, time_project_id, time_week_start, time_entry_id, time_spare_entry_id, time_stopper_token, time_stopper_project_id, time_idle_token
"""
Provision, through MedexRegAI's own HTTP APIs, three firms for F4.1 time capture:

  time_token / time_project_id   "logger": in the week starting time_week_start (last week's
                                 Monday, UTC) it has 2 h of tabulate on the project and 1 h of
                                 write on no project (3 h, 2 entries); a spare 30 min entry two
                                 weeks earlier (time_spare_entry_id, for the delete test); and a
                                 read timer running now (not in that week).
  time_entry_id                  the logger's tabulate entry (edit test)
  time_stopper_token             "stopper": a timer running now (stop test), on
  time_stopper_project_id        its own project (another firm's project for the logger)
  time_idle_token                "idle": no timer and no entries (stop -> 404)
  time_week_end                  the Monday after that week (export upper bound)
  time_manual_start / _end       an hour three days ago (10:00-11:00 UTC), for typed-in entries

Each person sees only their own time, so these never collide with the definitions' own
POST tests, which use the suite's registered account. Standard library only.
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


def firm(label, with_project=True):
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': f'Fixture {label}',
        'email': f'fixture-time-{label.lower()}-{secrets.token_hex(6)}@example.test',
        'password': PASSWORD,
        'firmName': f'Fixture {label} Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    if not with_project:
        return token, None
    client = expect(*call('POST', '/api/clients', {'name': f'Fixture Client {secrets.token_hex(4)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set'}, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Traditional 510(k)', 'submissionType': 'traditional'}, token), 201, 'project')
    return token, project['id']


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def entry(token, code, start, hours, project_id=None):
    body = {'activityCode': code, 'startedAt': iso(start), 'endedAt': iso(start + timedelta(hours=hours))}
    if project_id:
        body['projectId'] = project_id
    return expect(*call('POST', '/api/time/entries', body, token), 201, f'{code} entry')['id']


def main():
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    this_monday = today - timedelta(days=today.weekday())
    week = this_monday - timedelta(days=7)

    token, project_id = firm('Logger')
    entry_id = entry(token, 'tabulate', week + timedelta(days=1, hours=9), 2, project_id)
    entry(token, 'write', week + timedelta(days=2, hours=14), 1)
    spare_id = entry(token, 'read', week - timedelta(days=7) + timedelta(hours=10), 0.5)
    expect(*call('POST', '/api/time/start', {'activityCode': 'read', 'projectId': project_id}, token), 201, 'logger timer')
    summary = expect(*call('GET', f"/api/time/summary?weekStart={week.date().isoformat()}&tzOffset=0", None, token), 200, 'summary')
    if summary['totalSeconds'] != 3 * 3600 or summary['entryCount'] != 2:
        sys.exit(f"summary: {summary['totalSeconds']} s in {summary['entryCount']} entries; expected 10800 s in 2")

    stopper_token, stopper_project_id = firm('Stopper')
    expect(*call('POST', '/api/time/start', {'activityCode': 'chase', 'projectId': stopper_project_id}, stopper_token), 201, 'stopper timer')

    idle_token, _ = firm('Idle', with_project=False)

    values = {
        'time_manual_start': iso(today - timedelta(days=3) + timedelta(hours=10)),
        'time_manual_end': iso(today - timedelta(days=3) + timedelta(hours=11)),
        'time_token': token,
        'time_project_id': project_id,
        'time_week_start': week.date().isoformat(),
        'time_week_end': (week + timedelta(days=7)).date().isoformat(),
        'time_entry_id': entry_id,
        'time_spare_entry_id': spare_id,
        'time_stopper_token': stopper_token,
        'time_stopper_project_id': stopper_project_id,
        'time_idle_token': idle_token,
    }
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
