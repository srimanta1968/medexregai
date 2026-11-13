# @fixture scope=tenant tier=api reason="billing state only changes through Stripe's signed webhook, so each session makes a fresh firm and sends it signed test events through the app's own API"
# @exports bl_token, bl_credit_price, bl_plan_price
"""
F6.3 billing through Stripe TEST mode, via MedexRegAI's own HTTP APIs.

Needs STRIPE_SECRET_KEY (sk_test_) and STRIPE_WEBHOOK_SECRET on the API, and the same webhook
secret here (env STRIPE_WEBHOOK_SECRET, else read from server/.env, which git ignores). Uses the
TEST placeholder prices tagged metadata app=medexregai in the Stripe test account.

Stripe Checkout itself is a Stripe-hosted card page, so its completion is simulated the way Stripe
reports it: a checkout.session.completed event signed with the webhook secret (Stripe's documented
scheme: header t=<unix>,v1=HMAC-SHA256(secret, "<t>.<body>")). Asserts:
  - the catalog lists only app=medexregai prices (never other products in the Stripe account);
  - checkout returns a Stripe test Checkout URL;
  - a paid credit purchase adds its credits once: a resent event (same id) and a second event for
    the same payment change nothing;
  - a bad signature is refused (400 INVALID_SIGNATURE) and changes nothing;
  - a subscription checkout sets the plan; customer.subscription.deleted marks it canceled;
  - events for another firm never touch this one.
Standard library only.
"""

import hashlib
import hmac
import importlib.util
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect, API = fx.call, fx.expect, fx.API

OUT = os.environ.get('SETUP_VARS_OUT')


def webhook_secret():
    if os.environ.get('STRIPE_WEBHOOK_SECRET'):
        return os.environ['STRIPE_WEBHOOK_SECRET']
    path = os.path.join(HERE, '..', '..', 'server', '.env')
    for line in open(path, encoding='utf-8'):
        if line.startswith('STRIPE_WEBHOOK_SECRET='):
            return line.split('=', 1)[1].strip().strip('"')
    sys.exit('billing: STRIPE_WEBHOOK_SECRET not found (env or server/.env)')


SECRET = webhook_secret()


def fail(msg, data=None):
    sys.exit(f'billing: {msg}\n{json.dumps(data, indent=1)[:2000] if data is not None else ""}')


def send(event, secret=None):
    body = json.dumps(event, separators=(',', ':')).encode('utf-8')
    t = str(int(time.time()))
    sig = hmac.new((secret or SECRET).encode(), f'{t}.'.encode() + body, hashlib.sha256).hexdigest()
    req = urllib.request.Request(API + '/api/billing/stripe/webhook', data=body, method='POST',
                                 headers={'Content-Type': 'application/json', 'Stripe-Signature': f't={t},v1={sig}'})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b'{}')


def event(etype, obj):
    return {'id': f'evt_test_{secrets.token_hex(8)}', 'object': 'event', 'type': etype, 'api_version': '2025-01-27', 'created': int(time.time()),
            'livemode': False, 'data': {'object': obj}}


def firm(label):
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': f'Fixture Billing {label}', 'email': f'fixture-billing-{label.lower()}-{secrets.token_hex(5)}@example.test',
        'password': fx.PASSWORD, 'firmName': f'Fixture Billing Firm {label} {secrets.token_hex(3)}',
    }), 201, f'register {label}')
    me = expect(*call('GET', '/api/auth/me', None, owner['token']), 200, 'me')
    org_id = me.get('orgId') or (me.get('org') or {}).get('id') or (me.get('membership') or {}).get('orgId')
    if not org_id:
        fail('could not read the org id from /api/auth/me', me)
    return owner['token'], org_id


def main():
    token, org = firm('A')
    other_token, other_org = firm('B')

    view = expect(*call('GET', '/api/billing', None, token), 200, 'billing')
    if not view['testMode'] or not view['catalog'] or any('projexlight' in c['name'].lower() for c in view['catalog']):
        fail('catalog: test mode, and only app=medexregai prices', view['catalog'])
    credit = next((c for c in view['catalog'] if c['kind'] == 'credits'), None)
    plan = next((c for c in view['catalog'] if c['kind'] == 'plan'), None)
    if not credit or not plan:
        fail('need one credit pack and one plan tagged app=medexregai in the Stripe test account', view['catalog'])

    co = expect(*call('POST', '/api/billing/checkout', {'priceId': credit['priceId']}, token), 200, 'checkout')
    if not co['url'].startswith('https://checkout.stripe.com/') or not co['sessionId'].startswith('cs_test_'):
        fail('checkout returns a Stripe TEST checkout page', co)

    meta = {'org_id': org, 'app': 'medexregai', 'kind': 'credits', 'credits': str(credit['credits']), 'price_id': credit['priceId']}
    session = {'id': f'cs_test_fixture_{secrets.token_hex(6)}', 'object': 'checkout.session', 'mode': 'payment', 'payment_status': 'paid', 'metadata': meta}
    paid = event('checkout.session.completed', session)
    status, body = send(paid)
    if status != 200 or not body['data']['handled']:
        fail(f'paid credit event: {status}', body)
    status, body = send(paid)
    if status != 200 or not body['data']['duplicate']:
        fail('a resent event is recognised as a duplicate', body)
    send(event('checkout.session.completed', session))  # a second event for the same payment
    # Signed with a different key than the server's (the real one reversed): must be refused.
    status, body = send(event('checkout.session.completed', {**session, 'id': f'cs_test_fixture_{secrets.token_hex(6)}'}), SECRET[::-1])
    if status != 400 or body.get('error', {}).get('code') != 'INVALID_SIGNATURE':
        fail('a bad signature is refused', body)
    b = expect(*call('GET', '/api/billing', None, token), 200, 'billing after purchase')
    if b['creditBalance'] != credit['credits'] or len([l for l in b['ledger'] if l['reason'] == 'purchase']) != 1:
        fail(f"credits added exactly once: balance {b['creditBalance']}, want {credit['credits']}", b['ledger'])

    sub_meta = {'org_id': org, 'app': 'medexregai', 'kind': 'plan', 'plan': plan['plan'], 'price_id': plan['priceId']}
    sub_id = f'sub_test_fixture_{secrets.token_hex(6)}'
    status, body = send(event('checkout.session.completed', {'id': f'cs_test_fixture_{secrets.token_hex(6)}', 'object': 'checkout.session', 'mode': 'subscription',
                                                              'payment_status': 'paid', 'subscription': sub_id, 'metadata': sub_meta}))
    b = expect(*call('GET', '/api/billing', None, token), 200, 'billing after plan')
    if status != 200 or not b['plan'] or b['plan']['key'] != plan['plan'] or b['plan']['status'] != 'active':
        fail('a subscription checkout sets the plan', b['plan'])
    send(event('customer.subscription.deleted', {'id': sub_id, 'object': 'subscription', 'status': 'canceled', 'metadata': sub_meta}))
    b = expect(*call('GET', '/api/billing', None, token), 200, 'billing after cancel')
    if b['plan']['status'] != 'canceled':
        fail('a deleted subscription shows as canceled', b['plan'])

    o = expect(*call('GET', '/api/billing', None, other_token), 200, 'other firm')
    if o['creditBalance'] != 0 or o['plan'] is not None:
        fail("another firm's billing is untouched", o)

    values = {'bl_token': token, 'bl_credit_price': credit['priceId'], 'bl_plan_price': plan['priceId']}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
