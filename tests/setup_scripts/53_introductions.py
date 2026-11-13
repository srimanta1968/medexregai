# @fixture scope=tenant tier=api reason="routing is only provable with several firms whose opt-in differs, made fresh through the app's own APIs each session"
# @exports in_token, in_other_token, in_offered_id, in_decline_id, in_decided_id
"""
F6.2 opt-in introductions, through MedexRegAI's own HTTP APIs (FDA data service needed for the
product-code request). Makes three firms:

  A  opted in: Ophthalmic (OP), PMA
  B  NOT opted in, also Ophthalmic / PMA
  C  opted in, Cardiovascular (CV) only

then company requests (FICTIONAL TEST DATA) and asserts the routing rule, which the definitions
cannot see across firms:
  - an OP / PMA request reaches A, never B (not opted in) or C (other specialty);
  - an FPA (General Hospital, HO) 510(k) request reaches none of A, B, C;
  - before acceptance the firm sees the brief but no company name or contact;
  - accepting reveals them; deciding twice is refused (409 INTRODUCTION_DECIDED).
Newly opted-in firms are offered first (never offered before), and the script opts its firms back
out at the end, so firms from earlier runs never take A's place. Standard library only.
"""

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


def fail(msg, data=None):
    sys.exit(f'introductions: {msg}\n{json.dumps(data, indent=1)[:3000] if data is not None else ""}')


def firm(label, settings):
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': f'Fixture Intro {label}', 'email': f'fixture-intro-{label.lower()}-{secrets.token_hex(5)}@example.test',
        'password': fx.PASSWORD, 'firmName': f'Fixture Intro Firm {label} {secrets.token_hex(3)}',
    }), 201, f'register {label}')
    expect(*call('PUT', '/api/introductions/settings', settings, owner['token']), 200, f'settings {label}')
    return owner['token']


def ask(tag, **extra):
    body = {
        'companyName': f'Optisight {tag} (FICTIONAL)', 'contactName': 'Sam Okafor', 'contactEmail': f'sam-{tag.lower()}@example.test',
        'brief': f'FICTIONAL TEST DATA {tag}: a novel intraocular implant; we need a regulatory consultant for the submission.',
        'consent': True, **extra,
    }
    return expect(*call('POST', '/api/public/introduction-requests', body, None), 201, f'request {tag}')['id'], body['brief']


def offered(token, brief):
    items = expect(*call('GET', '/api/introductions?limit=50', None, token), 200, 'list')['items']
    return [i for i in items if i['brief'] == brief]


def main():
    a = firm('A', {'optedIn': True, 'specialties': ['OP'], 'pathways': ['pma'], 'profile': 'Ophthalmic PMA specialists (fictional).'})
    b = firm('B', {'optedIn': False, 'specialties': ['OP'], 'pathways': ['pma']})
    c = firm('C', {'optedIn': True, 'specialties': ['CV'], 'pathways': []})

    run = secrets.token_hex(3)
    briefs = []
    for n in range(3):
        _, brief = ask(f'{run}-{n}', specialty='OP', pathway='pma')
        briefs.append(brief)
        got_a, got_b, got_c = offered(a, brief), offered(b, brief), offered(c, brief)
        if len(got_a) != 1 or got_b or got_c:
            fail(f'OP/PMA request {n}: A {len(got_a)}, B {len(got_b)} (not opted in), C {len(got_c)} (CV only); want 1, 0, 0')
        if got_a[0]['status'] != 'offered' or got_a[0]['company'] is not None or got_a[0]['specialtyLabel'] != 'Ophthalmic' or got_a[0]['pathwayLabel'] != 'PMA':
            fail('an offered introduction shows the brief, specialty and pathway but not the company', got_a[0])

    _, ho_brief = ask(f'{run}-ho', productCode='FPA', pathway='510k')
    if offered(a, ho_brief) or offered(b, ho_brief) or offered(c, ho_brief):
        fail('an FPA (HO) 510(k) request must reach none of A (OP only), B (not opted in), C (CV only)')

    decided = offered(a, briefs[0])[0]
    accepted = expect(*call('POST', f"/api/introductions/{decided['id']}/accept", {}, a), 200, 'accept')
    if accepted['status'] != 'accepted' or not accepted['company'] or accepted['company']['contactEmail'] != f'sam-{run}-0@example.test':
        fail('accepting reveals the company and contact', accepted)
    status, again = call('POST', f"/api/introductions/{decided['id']}/decline", {}, a)
    if status != 409 or again.get('error', {}).get('code') != 'INTRODUCTION_DECIDED':
        fail(f'deciding twice must be 409 INTRODUCTION_DECIDED, got {status}', again)

    # Opt the fixture firms back out so firms from earlier runs never pile up in routing and push a
    # later run's firm A out of the first FANOUT matches. Offers already made stay decidable.
    for token in (a, c):
        expect(*call('PUT', '/api/introductions/settings', {'optedIn': False, 'specialties': [], 'pathways': []}, token), 200, 'opt out')

    values = {
        'in_token': a, 'in_other_token': c,
        'in_offered_id': offered(a, briefs[1])[0]['id'], 'in_decline_id': offered(a, briefs[2])[0]['id'], 'in_decided_id': decided['id'],
    }
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
