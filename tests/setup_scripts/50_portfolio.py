# @fixture scope=tenant tier=api reason="the portfolio aggregates a whole firm (projects, FDA letters, client requests), so each session makes a fresh firm with known contents through the app's own APIs"
# @exports pf_token, pf_client_id, pf_letter_project_id, pf_overdue_project_id
"""
Provision, through MedexRegAI's own HTTP APIs, a firm for the F5.3 portfolio:

  Letter project    an open FDA AI request issued 170 days ago (due in 10 days by FDA's 180-day rule)
                    with two deficiencies, one marked ready
  Overdue project   target date 5 days ago, nothing else open
  Waiting project   target date in 60 days and one approved (open) client request
  Cleared project   status cleared: shown only with status=cleared or all

Asserts what the definitions cannot (arrays and their order): the totals, the soonest-due-first
order, each row's stage, next action, due date and risks, the status filter and cursor paging.
Dates are relative to today. Standard library only.
"""

import datetime
import importlib.util
import json
import os
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect = fx.call, fx.expect

OUT = os.environ.get('SETUP_VARS_OUT')
TODAY = datetime.date.today()


def day(n):
    return (TODAY + datetime.timedelta(days=n)).isoformat()


def fail(msg, data):
    sys.exit(f'portfolio: {msg}\n{json.dumps(data, indent=1)[:3000]}')


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Fixture Portfolio Owner', 'email': f'fixture-portfolio-{secrets.token_hex(6)}@example.test',
        'password': fx.PASSWORD, 'firmName': f'Fixture Portfolio Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    client = expect(*call('POST', '/api/clients', {'name': f'Northbay Devices {secrets.token_hex(3)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set'}, token), 201, 'device')

    def project(name, **extra):
        return expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': name, 'submissionType': 'traditional', **extra}, token), 201, name)

    letter_p = project('Letter project', targetDate=day(90))
    overdue_p = project('Overdue project', targetDate=day(-5))
    waiting_p = project('Waiting project', targetDate=day(60))
    cleared_p = project('Cleared project', targetDate=day(-40))
    expect(*call('PATCH', f"/api/projects/{cleared_p['id']}", {'status': 'cleared'}, token), 200, 'clear project')

    letter = expect(*call('POST', f"/api/projects/{letter_p['id']}/fda-letters", {
        'kind': 'ai_request', 'fdaReference': 'K269998', 'issuedOn': day(-170),
        'deficiencies': [
            {'number': 1, 'summary': 'Provide ECH residual results', 'fdaText': 'Provide the ethylene chlorohydrin residual results.'},
            {'number': 2, 'summary': 'Clarify the shelf life', 'fdaText': 'Clarify the labeled shelf life.'},
        ],
    }, token), 201, 'letter')
    if letter['dueOn'] != day(10):
        fail(f"letter due {letter['dueOn']}, expected {day(10)}", letter)
    expect(*call('PATCH', f"/api/fda-deficiencies/{letter['deficiencies'][1]['id']}", {'status': 'ready'}, token), 200, 'deficiency ready')

    req = expect(*call('POST', f"/api/projects/{waiting_p['id']}/requests", {
        'title': 'Biocompatibility reports', 'items': [{'label': 'Cytotoxicity report'}],
    }, token), 201, 'client request')
    expect(*call('POST', f"/api/requests/{req['id']}/approve", {}, token), 200, 'approve request')

    data = expect(*call('GET', '/api/portfolio', None, token), 200, 'portfolio')
    t = data['totals']
    want = {'activeProjects': 3, 'openRequests': 1, 'highProblems': 0, 'fdaClocksRunning': 1, 'overdue': 1}
    if t != want:
        fail(f'totals {t}, expected {want}', data)
    names = [r['projectName'] for r in data['items']]
    if names != ['Overdue project', 'Letter project', 'Waiting project']:
        fail(f'order {names}: expected soonest due first, cleared hidden', data)
    rows = {r['projectName']: r for r in data['items']}

    o = rows['Overdue project']
    if o['stage'] != 'drafting' or not o['due'] or not o['due']['overdue'] or o['due']['daysLeft'] != -5 or o['riskLevel'] != 'high' \
            or 'Target date overdue by 5 days' not in o['risks'] or o['nextAction'] != 'Run the problem check':
        fail('overdue project row', o)
    lp = rows['Letter project']
    if lp['stage'] != 'fda_letter' or lp['stageLabel'] != 'FDA letter' \
            or lp['due'] != {'date': day(10), 'kind': 'fda_letter', 'daysLeft': 10, 'overdue': False} \
            or lp['counts']['openDeficiencies'] != 1 or lp['nextAction'] != 'Respond to FDA: 1 deficiency not ready' \
            or 'FDA response in 10 days' not in lp['risks'] or lp['riskLevel'] != 'medium':
        fail('letter project row (the FDA letter due date wins over the target date)', lp)
    w = rows['Waiting project']
    if w['stage'] != 'waiting_on_client' or w['counts']['openRequests'] != 1 or w['nextAction'] != 'Follow up 1 open client request' \
            or w['due']['kind'] != 'target_date' or w['riskLevel'] != 'low':
        fail('waiting project row', w)

    cleared = expect(*call('GET', '/api/portfolio?status=cleared', None, token), 200, 'cleared filter')
    if [r['projectName'] for r in cleared['items']] != ['Cleared project'] or cleared['items'][0]['risks'] \
            or cleared['items'][0]['nextAction'] is not None:
        fail('status=cleared lists only the cleared project, with no risks or next action', cleared)

    page1 = expect(*call('GET', '/api/portfolio?status=all&limit=2', None, token), 200, 'page 1')
    page2 = expect(*call('GET', f"/api/portfolio?status=all&limit=2&cursor={page1['nextCursor']}", None, token), 200, 'page 2')
    every = [r['projectName'] for r in page1['items'] + page2['items']]
    if len(every) != 4 or len(set(every)) != 4 or page2['nextCursor'] is not None:
        fail(f'cursor paging over 4 projects gave {every}', {'page1': page1, 'page2': page2})

    values = {'pf_token': token, 'pf_client_id': client['id'], 'pf_letter_project_id': letter_p['id'], 'pf_overdue_project_id': overdue_p['id']}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
