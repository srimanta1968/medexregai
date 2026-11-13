"""
F5.4 eSTAR XML spike tool: read a blank eSTAR PDF and write its field catalog, the input for a
versioned XML mapping (one catalog per eSTAR template version).

    python scripts/estar/xfa_catalog.py <blank eSTAR.pdf> <template key, e.g. nIVD-7.1> <out.json> [--skeleton out.xml]

The eSTAR is a dynamic XFA form (NeedsRendering, no AcroForm fields). Its data is stored in the
XFA `datasets` packet under <xfa:data><root>...; fields bind to data implicitly by name through
named subforms, so a field's data path is the chain of named subforms down to it. This tool
records, for every data-bound field and radio group (buttons and match="none" bindings are
skipped): path, UI kind, caption or tool tip, allowed values (choice lists: display and save
values; radios: each option's caption and saved value; checkboxes: on/off values) and whether it
sits in a repeating subform. --skeleton writes the blank form's own data DOM (the starting point
an exporter fills in).

Run it on a file downloaded from FDA's eSTAR page, never on a filled-in client eSTAR. Needs pypdf.
"""

import datetime
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET

# Keep the xfa: prefix the form uses on data-node attributes. Rich-text (xhtml) nodes are written
# with an html: prefix; the namespace is the same as the form's default-namespace markup.
ET.register_namespace('xfa', 'http://www.xfa.org/schema/xfa-data/1.0/')
ET.register_namespace('html', 'http://www.w3.org/1999/xhtml')

from pypdf import PdfReader

XFA_DATA = 'http://www.xfa.org/schema/xfa-data/1.0/'


def packets(pdf_path):
    form = PdfReader(pdf_path).trailer['/Root']['/AcroForm'].get_object()
    xfa = form['/XFA'].get_object()
    return {str(xfa[i]): xfa[i + 1].get_object().get_data() for i in range(0, len(xfa), 2)}


def ln(tag):
    return tag.split('}', 1)[-1]


def child(e, name):
    return next((c for c in e if ln(c.tag) == name), None)


def text_of(e):
    return '' if e is None else re.sub(r'\s+', ' ', ''.join(e.itertext())).strip()


def caption(e):
    c = child(e, 'caption')
    return text_of(child(c, 'value')) if c is not None else ''


def tooltip(e):
    a = child(e, 'assist')
    if a is None:
        return ''
    return text_of(child(a, 'toolTip')) or text_of(child(a, 'speak'))


def bind_match(e):
    b = child(e, 'bind')
    return b.get('match', 'once') if b is not None else 'once'


def repeats(e):
    o = child(e, 'occur')
    return o is not None and o.get('max', '1') != '1'


def items(e):
    lists = [[text_of(x) for x in c] for c in e if ln(c.tag) == 'items']
    if not lists:
        return None
    return {'display': lists[0], 'save': lists[1]} if len(lists) == 2 else {'values': lists[0]}


def catalog(template_xml):
    root = ET.fromstring(template_xml)
    fields = []

    def walk(e, path, repeating):
        tag, name = ln(e.tag), e.get('name')
        if tag in ('subform', 'area'):
            named = tag == 'subform' and name and bind_match(e) != 'none'
            for c in e:
                walk(c, path + [name] if named else path, repeating or bool(named and repeats(e)))
        elif tag == 'exclGroup' and name and bind_match(e) != 'none':
            opts = []
            for f in e:
                if ln(f.tag) == 'field':
                    it = items(f) or {}
                    opts.append({'caption': caption(f) or tooltip(f), 'value': (it.get('values') or [None])[0]})
            fields.append({'path': '/'.join(path + [name]), 'kind': 'radio', 'caption': caption(e) or tooltip(e), 'options': opts, 'inRepeat': repeating})
        elif tag == 'field' and name and bind_match(e) != 'none':
            ui = child(e, 'ui')
            kind = ln(list(ui)[0].tag) if ui is not None and len(list(ui)) else 'textEdit'
            if kind == 'button':
                return
            f = {'path': '/'.join(path + [name]), 'kind': kind, 'caption': caption(e) or tooltip(e), 'inRepeat': repeating}
            it = items(e)
            if it:
                f['items'] = it
            fields.append(f)
        else:
            for c in e:
                walk(c, path, repeating)

    top = next(c for c in root if ln(c.tag) == 'subform')
    for c in top:
        walk(c, [], False)
    return top.get('name'), fields


def main():
    args = sys.argv[1:]
    skeleton_out = None
    if '--skeleton' in args:
        i = args.index('--skeleton')
        skeleton_out = args[i + 1]
        del args[i:i + 2]
    pdf_path, key, out = args
    raw = open(pdf_path, 'rb').read()
    p = packets(pdf_path)
    data_root, fields = catalog(p['template'])
    ds = ET.fromstring(p['datasets'])
    data = ds.find(f'{{{XFA_DATA}}}data')[0]
    version = (data.findtext('Version') or '').strip()
    meta = {
        'templateKey': key,
        'sourcePdfSha256': hashlib.sha256(raw).hexdigest(),
        'catalogedOn': datetime.date.today().isoformat(),
        'dataRoot': data_root,
        'dataVersion': version,
        'xfaTemplateNamespace': re.search(rb'<template[^>]*xmlns="([^"]+)"', p['template']).group(1).decode(),
        'fieldCount': len(fields),
        'runtimeFilledChoiceLists': [f['path'] for f in fields if f['kind'] == 'choiceList' and not (f.get('items') or {}).get('display')],
    }
    with open(out, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump({**meta, 'fields': fields}, fh, indent=1, ensure_ascii=False)
        fh.write('\n')
    if skeleton_out:
        with open(skeleton_out, 'wb') as fh:
            fh.write(b'<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(data, encoding='utf-8', xml_declaration=False))
    print(json.dumps({k: v for k, v in meta.items() if k != 'runtimeFilledChoiceLists'}))


if __name__ == '__main__':
    main()
