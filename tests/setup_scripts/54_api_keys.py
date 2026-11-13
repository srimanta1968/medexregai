# @fixture scope=tenant tier=api reason="scoped API keys can only be proven with real keys of different scopes, made in a fresh firm through the app's own APIs"
# @exports ak_token, ak_portfolio_key, ak_fda_key, ak_revoked_key, ak_delete_key_id
"""
F6.3 API keys, through MedexRegAI's own HTTP APIs (fda:read routes need the fda-data service).

Makes a firm with keys: P (portfolio:read), F (fda:read), R (fda:read, then revoked) and D (to be
revoked by the delete definition). Asserts what the definitions cannot see together:
  - the secret is returned once at creation and never in the list (only its prefix);
  - P reads /api/v1/portfolio but gets 403 INSUFFICIENT_SCOPE on /api/v1/fda/...;
  - F reads FDA data but gets 403 on the portfolio;
  - a revoked key, an unknown key and a signed-in user's JWT all get 401 on /api/v1;
  - an API key is refused by the app's own routes (401), so keys reach only /api/v1.
Test keys only (fictional firm). Standard library only.
"""

import importlib.util
import json
import os
import secrets
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect, API = fx.call, fx.expect, fx.API

OUT = os.environ.get('SETUP_VARS_OUT')


def fail(msg, data=None):
    sys.exit(f'api keys: {msg}\n{json.dumps(data, indent=1)[:2000] if data is not None else ""}')


def with_key(path, key, header='Authorization'):
    value = f'Bearer {key}' if header == 'Authorization' else key
    req = urllib.request.Request(API + path, headers={header: value, 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b'{}')


def code_of(body):
    return (body.get('error') or {}).get('code')


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Fixture Keys Owner', 'email': f'fixture-keys-{secrets.token_hex(6)}@example.test',
        'password': fx.PASSWORD, 'firmName': f'Fixture Keys Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']

    def make(name, scopes, **extra):
        out = expect(*call('POST', '/api/api-keys', {'name': name, 'scopes': scopes, **extra}, token), 201, f'create {name}')
        if not out['secret'].startswith('mrk_') or out['key']['prefix'] != out['secret'][:10] or out['key']['status'] != 'active':
            fail('a new key returns its secret once, with a matching prefix', out['key'])
        return out

    p = make('Portfolio dashboard (test)', ['portfolio:read'])
    f = make('FDA lookups (test)', ['fda:read'], expiresInDays=30)
    r = make('Revoked key (test)', ['fda:read'])
    d = make('Key to revoke (test)', ['portfolio:read'])
    status, _ = call('DELETE', f"/api/api-keys/{r['key']['id']}", None, token)
    if status != 204:
        fail(f'revoke returned {status}')

    listed = expect(*call('GET', '/api/api-keys', None, token), 200, 'list')['items']
    if 'secret' in json.dumps(listed) or any(k['prefix'] and len(k['prefix']) != 10 for k in listed):
        fail('the list never carries a secret, only a 10-character prefix', listed)
    if {k['name']: k['status'] for k in listed}.get('Revoked key (test)') != 'revoked':
        fail('the revoked key shows as revoked', listed)

    checks = [
        ('P reads the portfolio', with_key('/api/v1/portfolio', p['secret']), 200, None),
        ('P reads the portfolio via X-Api-Key', with_key('/api/v1/portfolio', p['secret'], 'X-Api-Key'), 200, None),
        ('P has no fda:read', with_key('/api/v1/fda/product-codes/FPA', p['secret']), 403, 'INSUFFICIENT_SCOPE'),
        ('F reads a product code', with_key('/api/v1/fda/product-codes/FPA', f['secret']), 200, None),
        ('F reads a 510(k)', with_key('/api/v1/fda/510k/K230022', f['secret']), 200, None),
        ('F has no portfolio:read', with_key('/api/v1/portfolio', f['secret']), 403, 'INSUFFICIENT_SCOPE'),
        ('revoked key', with_key('/api/v1/fda/product-codes/FPA', r['secret']), 401, 'INVALID_API_KEY'),
        ('unknown key', with_key('/api/v1/portfolio', 'mrk_' + secrets.token_urlsafe(32)), 401, 'INVALID_API_KEY'),
        ("a signed-in user's JWT", with_key('/api/v1/portfolio', token), 401, 'INVALID_API_KEY'),
        ("an API key on the app's own route", with_key('/api/portfolio', p['secret']), 401, None),
    ]
    for name, (status, body), want, want_code in checks:
        if status != want or (want_code and code_of(body) != want_code):
            fail(f'{name}: got {status} {code_of(body)}, want {want} {want_code or ""}', body)
    if with_key('/api/v1/fda/product-codes/FPA', f['secret'])[1]['data']['productCode'] != 'FPA':
        fail('fda:read returns the FDA record')

    values = {'ak_token': token, 'ak_portfolio_key': p['secret'], 'ak_fda_key': f['secret'], 'ak_revoked_key': r['secret'], 'ak_delete_key_id': d['key']['id']}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
