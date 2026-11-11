# @fixture scope=tenant tier=api reason="fresh reviewer + second-firm account per session; tokens expire in 15 minutes, so this cannot be a once-per-environment seed"
# @exports reviewer_token, reviewer_email, other_account_email
"""
Provision, through MedexRegAI's own HTTP APIs, the extra people the auth and invite
definitions need for their negative cases:

  reviewer_token / reviewer_email
      A REVIEWER in a firm (owner invites, invitee accepts). Proves the RBAC guard:
      routes that need members:invite answer 403 FORBIDDEN to this token.

  other_account_email
      The owner of a SECOND firm. An existing account that is not a member of the
      session firm: registering it again is 409 EMAIL_TAKEN, and inviting it gives an
      invite whose accept with a wrong password is 401 INVALID_CREDENTIALS.

Every account uses a fresh random email, so the script is safe to re-run and never
collides with data from an earlier run. Exported through $SETUP_VARS_OUT as JSON;
definitions read the values as {{var:<name>}}. Standard library only.
"""

import json
import os
import secrets
import sys
import urllib.error
import urllib.request

API = (os.environ.get('API_BASE_URL') or 'http://localhost:3000').rstrip('/')
OUT = os.environ.get('SETUP_VARS_OUT')
# Fixture accounts get a random password each run; nothing here is a stored secret.
PASSWORD = 'Fx-' + secrets.token_urlsafe(18)


def call(method, path, body=None, token=None):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b'{}')


def expect(status, payload, wanted, what):
    if status != wanted:
        code = (payload.get('error') or {}).get('code')
        sys.exit(f'{what}: expected {wanted}, got {status} {code}')
    return payload['data']


def email(kind):
    return f'fixture-{kind}-{secrets.token_hex(6)}@example.test'


def register(kind, firm):
    s, p = call('POST', '/api/auth/register', {'fullName': f'Fixture {kind.title()}', 'email': email(kind), 'password': PASSWORD, 'firmName': firm})
    return expect(s, p, 201, f'register {kind}')


def main():
    owner = register('owner', 'Fixture Firm')
    reviewer_email = email('reviewer')
    s, p = call('POST', '/api/invites', {'email': reviewer_email, 'role': 'reviewer'}, owner['token'])
    invite = expect(s, p, 201, 'invite reviewer')
    s, p = call('POST', f"/api/invites/{invite['inviteToken']}/accept", {'fullName': 'Fixture Reviewer', 'password': PASSWORD})
    reviewer = expect(s, p, 200, 'accept reviewer invite')
    if reviewer['role'] != 'reviewer':
        sys.exit(f"reviewer joined with role {reviewer['role']}")

    other = register('other', 'Fixture Other Firm')

    exported = {
        'reviewer_token': reviewer['token'],
        'reviewer_email': reviewer_email,
        'other_account_email': other['user']['email'],
    }
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(exported, fh)
    print(f"provisioned reviewer {reviewer_email} and other account {other['user']['email']}")


if __name__ == '__main__':
    main()
