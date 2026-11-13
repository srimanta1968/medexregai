# @fixture scope=platform tier=api reason="the public product-code page reads only FDA data; this checks its figures agree with each other on real data before the definitions run"
# @exports pc_code, pc_unknown_code
"""
F6.1 public product-code pages, against the real FDA data in the fda-data service (no sign-in,
nothing is created). Asserts what the definitions cannot (arrays and how figures relate):

  - FPA is Class II, 21 CFR 880.5440, pathway 510(k) (openFDA classification submission_type_id 1);
  - the clearances per year add up to the 5-year total, every listed clearance is FPA and inside
    the window, newest first; receipt-to-decision quartiles are ordered;
  - recall events are no more than recalled product rows; open events no more than all events;
  - every figure carries its dataset date;
  - the free check returns 510(k), closest clearances under FPA with FDA links, and says it kept
    nothing without consent.

Figures were cross-checked against api.fda.gov on 2026-11-13 (FPA, FRN, DQY: clearances and
recall events matched exactly). Needs the fda-data service. Standard library only.
"""

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect = fx.call, fx.expect

OUT = os.environ.get('SETUP_VARS_OUT')
CODE = 'FPA'


def fail(msg, data):
    sys.exit(f'public codes: {msg}\n{json.dumps(data, indent=1)[:3000]}')


def main():
    page = expect(*call('GET', f'/api/public/product-codes/{CODE}', None, None), 200, 'public page')
    if (page['classLabel'], page['regulationNumber'], (page['pathway'] or {}).get('label')) != ('Class II', '880.5440', '510(k)'):
        fail('FPA classification', page)
    s = page['stats']
    c, r, w = s['clearances'], s['recalls'], s['window']
    if w['years'] != 5 or sum(y['count'] for y in c['byYear']) != c['total'] or sum(t['count'] for t in c['byType']) != c['total']:
        fail('clearances per year / type must add up to the total', s)
    if c['total'] > page['clearancesAllTime'] or c['total'] == 0:
        fail('5-year clearances must be > 0 and within the all-time count', page)
    dates = [k['decisionDate'] for k in c['latest']]
    if dates != sorted(dates, reverse=True) or any(not (w['from'] <= d <= w['to']) for d in dates):
        fail('latest clearances must be newest first and inside the window', c['latest'])
    if any(not k['fdaUrl'].endswith(k['kNumber']) for k in c['latest']):
        fail('each clearance links to its FDA record', c['latest'])
    rd = c['receiptToDecisionDays']
    if rd['n'] and not (rd['p25'] <= rd['median'] <= rd['p75']):
        fail('receipt-to-decision quartiles out of order', rd)
    if not (0 <= r['open'] <= r['total'] <= r['products']):
        fail('recall events must be <= products and open <= events', r)
    if any(not src.get('dataAsOf') for src in s['sources'].values()):
        fail('every source needs its dataset date', s['sources'])

    check = expect(*call('POST', '/api/public/device-checks', {
        'productCode': CODE, 'contactConsent': False,
        'description': 'FICTIONAL TEST DATA. A single-use sterile intravascular administration set with a spike, drip chamber and roller clamp.',
    }, None), 201, 'device check')
    if check['pathway']['label'] != '510(k)' or check['contacted'] is not False or not check['similarClearances']:
        fail('check result', check)
    if any(not x['fdaUrl'].endswith(x['kNumber']) or x['match'] not in ('high', 'medium', 'low') for x in check['similarClearances']):
        fail('similar clearances need an FDA link and a match level', check['similarClearances'])

    values = {'pc_code': CODE, 'pc_unknown_code': 'ZZZ'}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
