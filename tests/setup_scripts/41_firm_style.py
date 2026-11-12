# @fixture scope=tenant tier=api reason="a draft written with firm style and claim-checked edits can only come from the drafter (parse + model call), and two firms are needed to show style sources never cross tenants, so each session makes them through the app's own APIs"
# @exports style_token, style_project_id, style_section_id, style_template_id, style_precedent_id, other_token, other_project_id, other_section_id, other_template_id, other_precedent_id, other_spare_precedent_id
"""
Provision, through MedexRegAI's own HTTP APIs, two firms for F3.6 (firm style sources,
claim checker, summary tables and administrative documents):

  Firm A (style on)
    style_token           owner of firm A (Bearer token)
    style_project_id      its project; device IS-200 infusion set, product code FPA
    style_section_id      the project's Sterility section. Its first draft was written with the
                          firm's Sterility template and one precedent (style.usedCount = 2); the
                          latest version is an imported edit adding three sentences:
                            - an intended use the project has no Indications for Use for,
                            - a claim ("eliminates") no source makes,
                            - ISO 11135:2007, where the filed report states ISO 11135:2014
                          so two human statements carry claim warnings and the summary table
                          shows exactly one mismatch (EDITION).
    style_template_id     firm A's Sterility template
    style_precedent_id    firm A's Sterility precedent

  Firm B (style off: turned on, then off again)
    other_token, other_project_id, other_section_id (Sterility), other_template_id,
    other_precedent_id, other_spare_precedent_id (a second precedent, for delete tests)

The fixture itself asserts what it relies on: firm B sees no precedent while style is off,
sees its own when on, and none again after turning it off.

Firm A needs a model-written draft (about 50 s), close to the runner's 60 s limit for a setup
script, so its account is cached in tests/setup_scripts/.cache/ (git-ignored, test accounts
only) and reused when every fact above still holds; otherwise it is built again. Firm B is
cheap and always fresh, so the definitions that create or delete rows use firm B.

Needs the dev stack with docproc, the generation model (Ollama) and the FDA data service.
The test report is FICTIONAL (built here; no real company or device). Standard library only.
"""

import base64
import importlib.util
import io
import json
import os
import secrets
import sys
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('draft_check_fixture', os.path.join(HERE, '40_draft_check.py'))
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
call, expect, esc, source_docx, wait_parsed = fx.call, fx.expect, fx.esc, fx.source_docx, fx.wait_parsed

OUT = os.environ.get('SETUP_VARS_OUT')
CACHE = os.path.join(HERE, '.cache', '41_firm_style.json')

REPORT = [
    'EO-12 Ethylene Oxide Sterilization Validation Report, Revision A',
    'The IS-200 infusion set is sterilized using 100% ethylene oxide in a validated cycle.',
    'The sterilization process was validated using the overkill half-cycle approach in accordance with ISO 11135:2014.',
    'Acceptance criteria: no growth of any biological indicator in all three half cycles.',
    'Biological indicators were inactivated in all three half cycles, which demonstrates a sterility assurance level (SAL) of 10^-6.',
    'All acceptance criteria were met.',
]

TEMPLATE = 'State the sterilization method first, then the validation standard and approach, then the SAL, then residuals.'
PRECEDENT = 'The subject device is sterilized by ethylene oxide. Sterilization was validated using the overkill half-cycle method to a SAL of 10^-6.'

EDITS = [
    'The IS-200 infusion set is indicated for subcutaneous delivery of insulin in pediatric patients at home.',
    'The in-line filter eliminates particulate contamination.',
    'Sterilization was validated in accordance with ISO 11135:2007.',
]


def with_paragraphs(export_bytes, paragraphs):
    """The consultant's own paragraphs added at the end of the exported draft."""
    src = zipfile.ZipFile(io.BytesIO(export_bytes))
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in src.namelist():
            data = src.read(name)
            if name == 'word/document.xml':
                xml = data.decode('utf-8')
                para = ''.join(f'<w:p><w:r><w:t xml:space="preserve">{esc(t)}</w:t></w:r></w:p>' for t in paragraphs)
                if '<w:sectPr>' not in xml:
                    sys.exit('edit: no section properties in the export')
                data = xml.replace('<w:sectPr>', para + '<w:sectPr>', 1).encode('utf-8')
            z.writestr(name, data)
    return out.getvalue()


def firm(label, email=None):
    email = email or f'fixture-style-{label.lower()}-{secrets.token_hex(6)}@example.test'
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': f'Fixture {label}',
        'email': email,
        'password': fx.PASSWORD,
        'firmName': f'Fixture {label} Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    client = expect(*call('POST', '/api/clients', {'name': f'Fixture Client {secrets.token_hex(4)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set', 'productCode': 'FPA'}, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Traditional 510(k)', 'submissionType': 'traditional'}, token), 201, 'project')
    board = expect(*call('GET', f"/api/projects/{project['id']}/sections", None, token), 200, 'board')
    section = next(s for s in board['sections'] if s['sectionId'] == 'sterility')
    return token, project['id'], section['id']


def style_switch(token, on):
    expect(*call('PUT', '/api/style-sources', {'enabled': on}, token), 200, 'style switch')


def precedent(token, label, text=PRECEDENT):
    return expect(*call('POST', '/api/precedents', {'sectionId': 'sterility', 'sourceLabel': label, 'text': text}, token), 201, 'precedent')['id']


def section_style(token, section_id):
    return expect(*call('GET', f'/api/project-sections/{section_id}/precedents', None, token), 200, 'section precedents')


def cached_studio():
    """Firm A from an earlier run, when everything this fixture promises about it still holds."""
    try:
        with open(CACHE, encoding='utf-8') as fh:
            c = json.load(fh)
    except (OSError, ValueError):
        return None
    # Same database whether reached as localhost or host.docker.internal: signing in is the test.
    status, payload = call('POST', '/api/auth/login', {'email': c['email'], 'password': c['password']})
    if status != 200:
        return None
    token = payload['data']['token']
    status, payload = call('GET', f"/api/project-sections/{c['section_id']}/draft", None, token)
    draft = (payload.get('data') or {}).get('draft') if status == 200 else None
    if not draft or draft['status'] != 'ready' or draft['origin'] != 'imported' or draft['claimCheck']['humanWarned'] != 2:
        return None
    first = next((v for v in (payload['data'].get('versions') or []) if v['versionNo'] == 1), None)
    if not first:
        return None
    status, payload = call('GET', f"/api/project-sections/{c['section_id']}/draft?version=1", None, token)
    if status != 200 or payload['data']['draft']['style']['usedCount'] != 2:
        return None
    status, payload = call('GET', f"/api/projects/{c['project_id']}/summary-tables", None, token)
    if status != 200 or payload['data']['mismatchCount'] != 1:
        return None
    status, payload = call('GET', f"/api/project-sections/{c['section_id']}/precedents", None, token)
    style = payload.get('data') or {}
    if status != 200 or not style.get('enabled') or style.get('precedentCount') != 1 or not (style.get('template') or {}).get('inUse'):
        return None
    return token, c


def main():
    cached = cached_studio()
    if cached:
        token, c = cached
        project_id, section_id, template_id, precedent_id = c['project_id'], c['section_id'], c['template_id'], c['precedent_id']
    else:
        token, project_id, section_id, template_id, precedent_id = studio()
    other(token, project_id, section_id, template_id, precedent_id)


def studio():
    """Firm A: style on, a draft written with it, an edit with claims."""
    email = f'fixture-style-studio-{secrets.token_hex(6)}@example.test'
    token, project_id, section_id = firm('Studio', email)
    style_switch(token, True)
    template_id = expect(*call('POST', '/api/templates', {'sectionId': 'sterility', 'name': 'Studio sterility outline', 'body': TEMPLATE}, token), 201, 'template')['id']
    precedent_id = precedent(token, 'K000000, Sterility (fixture)')

    upload = expect(*call('POST', f'/api/projects/{project_id}/files', {
        'fileName': 'EO-12 validation report.docx',
        'contentBase64': base64.b64encode(source_docx(REPORT)).decode('ascii'),
    }, token), 201, 'upload')
    wait_parsed(token, upload['id'])
    expect(*call('PUT', f"/api/files/{upload['id']}/assignment", {'sectionId': 'sterility'}, token), 200, 'assign')

    for _attempt in range(3):
        expect(*call('POST', f'/api/project-sections/{section_id}/draft', None, token), 202, 'request draft')
        for _ in range(90):
            current = expect(*call('GET', f'/api/project-sections/{section_id}/draft', None, token), 200, 'draft')['draft']
            if current['status'] in ('ready', 'failed'):
                break
            time.sleep(2)
        if current['status'] == 'ready':
            break
    if current['status'] != 'ready':
        sys.exit(f"the draft did not finish ({current['status']}: {current.get('error')}); is the generation model running?")
    if current['style']['usedCount'] != 2:
        sys.exit(f"the draft recorded {current['style']['used']} as its style; expected the template and the precedent")

    status, export = call('GET', f'/api/project-sections/{section_id}/draft/export', None, token, raw=True)
    if status != 200:
        sys.exit(f'export: expected 200, got {status}')
    imported = expect(*call('POST', f'/api/project-sections/{section_id}/draft/import', {
        'fileName': 'Sterility draft.docx',
        'contentBase64': base64.b64encode(with_paragraphs(export, EDITS)).decode('ascii'),
    }, token), 201, 'import')
    if imported['claimCheck']['humanWarned'] != 2:
        sys.exit(f"claim check of the edit: {imported['claimCheck']}; expected 2 warned human statements")
    table = expect(*call('GET', f'/api/projects/{project_id}/summary-tables', None, token), 200, 'summary table')
    if table['mismatchCount'] != 1:
        sys.exit(f"summary table: {table['mismatchCount']} mismatches; expected 1 (ISO 11135:2007 vs 2014)")
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE, 'w', encoding='utf-8') as fh:
        json.dump({'email': email, 'password': fx.PASSWORD, 'project_id': project_id, 'section_id': section_id,
                   'template_id': template_id, 'precedent_id': precedent_id}, fh)
    return token, project_id, section_id, template_id, precedent_id


def other(token, project_id, section_id, template_id, precedent_id):
    """Firm B: style off by default, on, off again; then write every variable."""
    other_token, other_project_id, other_section_id = firm('Other')
    other_precedent_id = precedent(other_token, 'K000001, Sterility (fixture)')
    other_spare_precedent_id = precedent(other_token, 'K000002, Sterility (fixture)')
    other_template_id = expect(*call('POST', '/api/templates', {'sectionId': 'sterility', 'name': 'Other sterility outline', 'body': TEMPLATE}, other_token), 201, 'template')['id']
    seen = [section_style(other_token, other_section_id)['precedentCount']]
    style_switch(other_token, True)
    seen.append(section_style(other_token, other_section_id)['precedentCount'])
    style_switch(other_token, False)
    seen.append(section_style(other_token, other_section_id)['precedentCount'])
    if seen != [0, 2, 0]:
        sys.exit(f'firm B precedents while off/on/off: {seen}; expected [0, 2, 0]')

    values = {
        'style_token': token,
        'style_project_id': project_id,
        'style_section_id': section_id,
        'style_template_id': template_id,
        'style_precedent_id': precedent_id,
        'other_token': other_token,
        'other_project_id': other_project_id,
        'other_section_id': other_section_id,
        'other_template_id': other_template_id,
        'other_precedent_id': other_precedent_id,
        'other_spare_precedent_id': other_spare_precedent_id,
    }
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps(values))


if __name__ == '__main__':
    main()
