# @fixture scope=tenant tier=api reason="a ready section draft can only come from the drafter (parse + model call), so each session makes one through the app's own APIs"
# @exports draft_token, draft_section_id, draft_other_section_id, draft_import_base64, draft_project_id, revision_version_id
"""
Provision, through MedexRegAI's own HTTP APIs, a section with a READY generated draft for
the F3.2 export and import definitions:

  draft_token          owner of a fresh firm (Bearer token)
  draft_section_id     the project's Sterility section, whose latest draft is ready
  draft_other_section_id  another section of the same project (Device Description), to show
                       an export of one section is refused by another
  draft_project_id     the project
  revision_version_id  version 2 of the report (Revision B: EO residual 1.1 mg instead of 0.8 mg),
                       uploaded after the draft, so the draft's statements cite the old version
                       (F3.3 revision impact)
  draft_import_base64  an edited copy of that draft's DOCX export (one statement extended,
                       one paragraph added), as a consultant would send back

Steps: register, client, device, project; upload a FICTIONAL EO validation report (DOCX
built here, no real company or device); wait for it to be read; file it under Sterility;
request a draft and wait until it is ready; export it and edit the Word XML.

Needs the dev stack with docproc and the generation model (Ollama) running: drafting takes
about 30-60 s on qwen2.5:3b. Fresh random names every run. Standard library only.
"""

import base64
import io
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
import zipfile

API = (os.environ.get('API_BASE_URL') or 'http://localhost:3000').rstrip('/')
OUT = os.environ.get('SETUP_VARS_OUT')
PASSWORD = 'Fx-' + secrets.token_urlsafe(18)

REPORT = [
    'EO-09 Ethylene Oxide Sterilization Validation Report, Revision A',
    'The IS-200 infusion set is sterilized using 100% ethylene oxide in a validated cycle.',
    'The sterilization process was validated using the overkill half-cycle approach in accordance with ISO 11135:2014.',
    'Biological indicators were inactivated in all three half cycles, which demonstrates a sterility assurance level (SAL) of 10^-6.',
    'The EO residual was 0.8 mg per device against a limit of 4 mg per device, evaluated in accordance with ISO 10993-7:2008.',
]


def call(method, path, body=None, token=None, raw=False):
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            payload = res.read()
            return res.status, payload if raw else json.loads(payload or b'{}')
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b'{}')


def expect(status, payload, wanted, what):
    if status != wanted:
        code = (payload.get('error') or {}).get('code') if isinstance(payload, dict) else None
        sys.exit(f'{what}: expected {wanted}, got {status} {code}')
    return payload['data'] if isinstance(payload, dict) else payload


def esc(text):
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


REVISION_B = [t.replace('Revision A', 'Revision B').replace('0.8 mg', '1.1 mg') for t in REPORT]


def source_docx(paragraphs=None):
    body = ''.join(f'<w:p><w:r><w:t xml:space="preserve">{esc(t)}</w:t></w:r></w:p>' for t in (paragraphs or REPORT))
    parts = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/document.xml': f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>',
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, xml in parts.items():
            z.writestr(name, xml)
    return buf.getvalue()


def edited(export_bytes):
    """Extend the first statement inside its bookmark and add a paragraph of the consultant's own."""
    src = zipfile.ZipFile(io.BytesIO(export_bytes))
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in src.namelist():
            data = src.read(name)
            if name == 'word/document.xml':
                xml = data.decode('utf-8')
                xml, n = re.subn(r'(<w:bookmarkStart w:id="\d+" w:name="mx_s_1"/>.*?<w:t xml:space="preserve">)([^<]*?)\.(</w:t>)', r'\1\2, per protocol EO-09.\3', xml, count=1, flags=re.S)
                if n != 1:
                    sys.exit('edit: statement 1 not found in the export')
                xml = xml.replace('<w:sectPr>', '<w:p><w:r><w:t xml:space="preserve">The sterilization site is listed in Attachment 4.</w:t></w:r></w:p><w:sectPr>', 1)
                data = xml.encode('utf-8')
            z.writestr(name, data)
    return out.getvalue()


def wait_parsed(token, file_id):
    for _ in range(60):
        detail = expect(*call('GET', f'/api/files/{file_id}', None, token), 200, 'file')
        status = (detail.get('versions') or [{}])[0].get('parseStatus')
        if status in ('parsed', 'failed', 'unsupported'):
            break
        time.sleep(2)
    if status != 'parsed':
        sys.exit(f'the source report was not read (parse status {status}); is docproc running?')


def main():
    owner = expect(*call('POST', '/api/auth/register', {
        'fullName': 'Fixture Drafter',
        'email': f'fixture-drafter-{secrets.token_hex(6)}@example.test',
        'password': PASSWORD,
        'firmName': f'Fixture Drafting Firm {secrets.token_hex(4)}',
    }), 201, 'register')
    token = owner['token']
    client = expect(*call('POST', '/api/clients', {'name': f'Fixture Client {secrets.token_hex(4)}'}, token), 201, 'client')
    device = expect(*call('POST', f"/api/clients/{client['id']}/devices", {'name': 'IS-200 infusion set'}, token), 201, 'device')
    project = expect(*call('POST', f"/api/devices/{device['id']}/projects", {'name': 'IS-200 Traditional 510(k)', 'submissionType': 'traditional'}, token), 201, 'project')

    upload = expect(*call('POST', f"/api/projects/{project['id']}/files", {
        'fileName': 'EO-09 validation report.docx',
        'contentBase64': base64.b64encode(source_docx()).decode('ascii'),
    }, token), 201, 'upload')
    wait_parsed(token, upload['id'])
    expect(*call('PUT', f"/api/files/{upload['id']}/assignment", {'sectionId': 'sterility'}, token), 200, 'assign')

    board = expect(*call('GET', f"/api/projects/{project['id']}/sections", None, token), 200, 'board')
    section = next(s for s in board['sections'] if s['sectionId'] == 'sterility')
    # The model is small and not deterministic: a draft where nothing survives the citation
    # gate fails honestly, so ask again (up to three drafts) before giving up.
    for _attempt in range(3):
        expect(*call('POST', f"/api/project-sections/{section['id']}/draft", None, token), 202, 'request draft')
        for _ in range(90):
            current = expect(*call('GET', f"/api/project-sections/{section['id']}/draft", None, token), 200, 'draft')['draft']
            if current['status'] in ('ready', 'failed'):
                break
            time.sleep(2)
        if current['status'] == 'ready':
            break
    if current['status'] != 'ready':
        sys.exit(f"the draft did not finish ({current['status']}: {current.get('error')}); is the generation model running?")

    status, export = call('GET', f"/api/project-sections/{section['id']}/draft/export", None, token, raw=True)
    if status != 200:
        sys.exit(f'export: expected 200, got {status}')

    # The client sends Revision B: the draft now cites an old version.
    revised = expect(*call('POST', f"/api/projects/{project['id']}/files", {
        'fileName': 'EO-09 validation report.docx',
        'contentBase64': base64.b64encode(source_docx(REVISION_B)).decode('ascii'),
    }, token), 201, 'upload revision')
    if revised['latest']['versionNo'] != 2:
        sys.exit(f"revision: expected version 2, got {revised['latest']['versionNo']}")
    wait_parsed(token, revised['id'])

    values = {
        'draft_project_id': project['id'],
        'revision_version_id': revised['latest']['id'],
        'draft_token': token,
        'draft_section_id': section['id'],
        'draft_other_section_id': next(s['id'] for s in board['sections'] if s['sectionId'] == 'device_description'),
        'draft_import_base64': base64.b64encode(edited(export)).decode('ascii'),
    }
    if OUT:
        with open(OUT, 'w', encoding='utf-8') as fh:
            json.dump(values, fh)
    else:
        print(json.dumps({k: (v[:40] + '...' if len(v) > 40 else v) for k, v in values.items()}))


if __name__ == '__main__':
    main()
