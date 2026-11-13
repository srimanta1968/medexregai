# @fixture scope=tenant tier=api reason="two-step sign-in needs codes computed from a secret the API shows once, and a throttled account needs ten real failed sign-ins; nothing else can produce either"
# @exports mfa_token, mfa_recovery_code, mfa_user_token, mfa_disable_token, mfa_disable_recovery_code, mfa_plain_token, mfa_pending_token, throttled_email, throttled_password
"""
Provision, through MedexRegAI's own HTTP APIs, the F4.4 sign-in hardening cases:

  mfa_token / mfa_recovery_code     user A has two-step sign-in on (set up and confirmed here with a
                                    real TOTP code); a password sign-in gave this challenge token
                                    (valid 5 minutes); the recovery code is unused
  mfa_user_token                    an access token for user A (MFA already on)
  mfa_disable_token / ..._code      user B, also with MFA on, and one of B's recovery codes
  mfa_plain_token                   user C, MFA off and never set up
  mfa_pending_token                 user E, setup started but not confirmed
  throttled_email / ..._password    user D after 10 wrong passwords: even the right one gets 429

Standard library only.
"""

import base64
import hashlib
import hmac
import importlib.util
import json
import os
import secrets
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect = fx.call, fx.expect

OUT = os.environ.get('SETUP_VARS_OUT')


def totp(secret_b32, step):
    key = base64.b32decode(secret_b32 + '=' * ((8 - len(secret_b32) % 8) % 8))
    mac = hmac.new(key, struct.pack('>Q', step), hashlib.sha1).digest()
    o = mac[-1] & 15
    return str((struct.unpack('>I', mac[o:o + 4])[0] & 0x7fffffff) % 1000000).zfill(6)


def register(tag):
    email = f'fixture-{tag}-{secrets.token_hex(5)}@example.test'
    s = expect(*call('POST', '/api/auth/register', {
        'fullName': f'Fixture {tag}', 'email': email, 'password': fx.PASSWORD, 'firmName': f'Fixture {tag} Firm {secrets.token_hex(3)}',
    }), 201, f'register {tag}')
    return email, s['token']


def with_mfa(tag):
    email, token = register(tag)
    setup = expect(*call('POST', '/api/auth/mfa/setup', None, token), 200, f'mfa setup {tag}')
    enabled = expect(*call('POST', '/api/auth/mfa/enable', {'code': totp(setup['secret'], int(time.time() // 30))}, token), 200, f'mfa enable {tag}')
    if len(enabled['recoveryCodes']) != 10:
        sys.exit(f'{tag}: expected 10 recovery codes')
    return email, token, enabled['recoveryCodes']


def main():
    a_email, a_token, a_codes = with_mfa('mfa-a')
    challenge = expect(*call('POST', '/api/auth/login', {'email': a_email, 'password': fx.PASSWORD}), 200, 'login with mfa')
    if not challenge.get('mfaRequired') or 'token' in challenge:
        sys.exit('login for an MFA account must return a challenge, not a session')
    _, b_token, b_codes = with_mfa('mfa-b')
    _, c_token = register('mfa-c')
    _, e_token = register('mfa-e')
    expect(*call('POST', '/api/auth/mfa/setup', None, e_token), 200, 'mfa setup e')

    d_email, _ = register('throttled')
    for i in range(10):
        status, _ = call('POST', '/api/auth/login', {'email': d_email, 'password': f'wrong-password-{i}'})
        if status != 401:
            sys.exit(f'wrong password {i} answered {status}, expected 401')

    values = {
        'mfa_token': challenge['mfaToken'], 'mfa_recovery_code': a_codes[0], 'mfa_user_token': a_token,
        'mfa_disable_token': b_token, 'mfa_disable_recovery_code': b_codes[0], 'mfa_plain_token': c_token, 'mfa_pending_token': e_token,
        'throttled_email': d_email, 'throttled_password': fx.PASSWORD,
    }
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
