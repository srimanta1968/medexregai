# @fixture scope=tenant tier=api reason="the eSTAR XML is built from a project's client, device, models, consultant and SE comparisons, so each session makes them in a fresh firm through the app's own APIs"
# @exports ex_token, ex_project_id, ex_ivd_project_id
"""
F5.4 eSTAR XML data file (ADR-019), through MedexRegAI's own HTTP APIs. Needs ESTAR_XML_EXPORT=true
on the API and the fda-data service (SE comparisons read FDA records).

Makes: a firm whose owner is "Ana Lindqvist"; client Northbay Devices; device IS-200 infusion set
with product code FPA and models IS-200A and IS-200B; a Special 510(k) project with two SE
comparisons (K-numbers found by a keyword search); and an IVD project (template IVD-7.1, which has
no mapping yet).

Asserts on the downloaded XML (what the definitions cannot):
  - it parses, its root is <root>, and every element path of the blank template's data tree is
    still present (nothing of the form's own data was dropped);
  - US FDA, 510(k), Special (3), New Application/Submission (1) are set as saved codes;
  - two <Device> copies (one per model) and two <PredicateReference> copies with the K-numbers;
  - correspondent first/last name, email and firm name; applicant company is the client;
  - no attachment content and nothing the mapping does not name was changed.
Standard library only.
"""

import collections
import importlib.util
import json
import os
import secrets
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect = fx.call, fx.expect

OUT = os.environ.get('SETUP_VARS_OUT')
SKELETON = os.path.join(HERE, '..', '..', 'docs', 'spikes', 'estar-xml', 'skeleton-nIVD-7.1.xml')


def fail(msg, data=None):
    sys.exit(f'estar xml: {msg}\n{json.dumps(data, indent=1)[:3000] if data is not None else ""}')


def paths(root):
    out = collections.Counter()

    def walk(e, p):
        here = f'{p}/{e.tag}' if p else e.tag
        out[here] += 1
        for c in e:
            walk(c, here)
    walk(root, '')
    return out


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Ana Lindqvist', 'email': f'fixture-estar-{secrets.token_hex(6)}@example.test',
        'password': fx.PASSWORD, 'firmName': f'Lindqvist Regulatory {secrets.token_hex(3)}',
    }), 201, 'register')
    token = owner['token']
    client = expect(*call('POST', '/api/clients', {'name': f'Northbay Devices {secrets.token_hex(3)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {
        'name': 'IS-200 infusion set', 'productCode': 'FPA', 'deviceClass': 'II', 'modelNames': ['IS-200A', 'IS-200B'],
    }, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Special 510(k)', 'submissionType': 'special'}, token), 201, 'project')
    ivd = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IVD template project', 'submissionType': 'traditional'}, token), 201, 'ivd project')
    expect(*call('PUT', f"/api/projects/{ivd['id']}/estar-template", {'template': 'IVD-7.1'}, token), 200, 'set IVD template')

    found = expect(*call('GET', f"/api/projects/{project['id']}/predicates/search?mode=keyword&q=administration%20set&limit=5", None, token), 200, 'predicate search')
    ks = [c['kNumber'] for c in found['items']][:2]
    if len(ks) < 2:
        fail('need two candidate predicates', found)
    for k in ks:
        expect(*call('POST', f"/api/projects/{project['id']}/se-comparisons", {'kNumber': k}, token), 201, f'SE comparison {k}')

    report = expect(*call('GET', f"/api/projects/{project['id']}/estar-xml?format=json", None, token), 200, 'report')
    if report['templateKey'] != 'nIVD-7.1' or report['mappingVersion'] != 'nIVD-7.1/1' or report['importChecked'] is not False:
        fail('report header', report)
    if not report['fillByHand'] or not any(f['section'] == 'Classification' for f in report['fillByHand']):
        fail('report must list what to fill by hand, including Classification', report)

    status, raw = call('GET', f"/api/projects/{project['id']}/estar-xml?format=xml", None, token, raw=True)
    if status != 200:
        fail(f'xml download HTTP {status}', raw if isinstance(raw, dict) else None)
    root = ET.fromstring(raw)
    if root.tag != 'root':
        fail(f'root element is {root.tag}')
    blank = paths(ET.parse(SKELETON).getroot())
    got = paths(root)
    missing = [p for p in blank if p not in got]
    if missing:
        fail(f'{len(missing)} template paths missing, e.g. {missing[:5]}')
    extra = [p for p in got if p not in blank]
    if extra:
        fail(f'paths not in the template: {extra[:5]}')

    def val(p):
        return (root.findtext(p) or '').strip()
    want = {
        'ApplicationType/ATRadioButton100': '1',
        'ApplicationType/USA/ATRadioButton110': '1',
        'ApplicationType/USA/ATRadioButton115': '3',
        'ApplicationType/ApplicationSubType/ATRadioButton130': '1',
        'AdministrativeInformation/ApplicantInformation/ADTextField210': client['name'],
        'AdministrativeInformation/ApplicantInformation/ADDropDownList295': '1',
        'AdministrativeInformation/CorrespondentInformation/ADTextField340': 'Ana',
        'AdministrativeInformation/CorrespondentInformation/ADTextField330': 'Lindqvist',
        'IndicationsForUse/SubandDevice/IUTextField130': 'IS-200 infusion set',
    }
    wrong = {p: (val(p), v) for p, v in want.items() if val(p) != v}
    if wrong:
        fail('values (got, want)', wrong)
    if not val('AdministrativeInformation/CorrespondentInformation/ADTextField360').startswith('fixture-estar-'):
        fail('correspondent email')
    devices = root.findall('DeviceDescription/Devices/Device')
    if [(d.findtext('TradeName'), d.findtext('Model')) for d in devices] != [('IS-200 infusion set', 'IS-200A'), ('IS-200 infusion set', 'IS-200B')]:
        fail('one Device per model', [ET.tostring(d, encoding='unicode') for d in devices])
    preds = root.findall('PredicatesSE/PredicateReference')
    if [p.findtext('ADTextField830') for p in preds] != ks or any(p.findtext('ADDropDownList820') != '2' for p in preds):
        fail('one PredicateReference per SE comparison, with "has a submission number"', [ET.tostring(p, encoding='unicode')[:300] for p in preds])
    # Fields outside the mapping keep the template's own value.
    skel = ET.parse(SKELETON).getroot()
    for p in ('ApplicationType/USA/ATCheckBox117a', 'AdministrativeInformation/ApplicantInformation/ADDropDownList270', 'Version', 'AttachmentManifest'):
        if (skel.findtext(p) or '') != (root.findtext(p) or ''):
            fail(f'{p} changed from the template value')
    # Every filled path in the report is one the XML holds with that value (first copy for repeats).
    if len(report['filled']) < 15:
        fail('expected at least 15 filled fields', report['filled'])

    values = {'ex_token': token, 'ex_project_id': project['id'], 'ex_ivd_project_id': ivd['id']}
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
