"""
F5.4 eSTAR round-trip check (TK-4702, ADR-019): compare the XML MedexRegAI exported with the XML
Acrobat Pro exported (Export Data) after importing it into a blank eSTAR, and list for each
mapped field whether it survived.

    python scripts/estar/compare_roundtrip.py <sent.xml> <returned.xml> [--json out.json]

"Mapped" = every element whose value in sent.xml differs from the blank template's own value
(docs/spikes/estar-xml/skeleton-<key>.xml, picked by the template key in sent.xml's Version) plus
repeat counts (Device, PredicateReference, CorrespondentInformation). Version, SavedTime and
ViewerType* are ignored (the form rewrites them). Exit code 0 when every mapped field survived,
1 otherwise. The result is the evidence for marking fields `verified` or `failed` in
server/src/estar/mappings/<key>.ts and for recording the check in ADR-019.
"""

import collections
import json
import os
import sys
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SKELETONS = {'7.01': os.path.join(HERE, '..', '..', 'docs', 'spikes', 'estar-xml', 'skeleton-nIVD-7.1.xml')}
IGNORE = {'Version', 'SavedTime', 'ViewerType', 'ViewerTypeHistory', 'CompletionCheck', 'AttachmentManifest', 'Footer', 'FormID'}
REPEATS = ['DeviceDescription/Devices/Device', 'PredicatesSE/PredicateReference', 'AdministrativeInformation/CorrespondentInformation']


def leaves(root):
    """{path#n: text} for every leaf, n = occurrence index of a repeated path."""
    out = {}
    seen = collections.Counter()

    def walk(e, p):
        here = f'{p}/{e.tag}' if p else e.tag
        kids = list(e)
        if not kids:
            seen[here] += 1
            out[f'{here}#{seen[here]}'] = (e.text or '').strip()
        for c in kids:
            walk(c, here)
    for c in root:
        walk(c, '')
    return out


def main():
    args = sys.argv[1:]
    out_json = None
    if '--json' in args:
        i = args.index('--json')
        out_json = args[i + 1]
        del args[i:i + 2]
    sent_path, back_path = args
    sent, back = ET.parse(sent_path).getroot(), ET.parse(back_path).getroot()
    version = (sent.findtext('Version') or '').strip()
    if version not in SKELETONS:
        sys.exit(f'no skeleton for template data version {version!r}')
    blank = leaves(ET.parse(SKELETONS[version]).getroot())
    s, b = leaves(sent), leaves(back)

    rows = []
    for key, value in s.items():
        top = key.split('/')[0].split('#')[0]
        if top in IGNORE or value == '' or blank.get(key) == value:
            continue
        got = b.get(key)
        rows.append({'field': key, 'sent': value, 'returned': got, 'survived': got == value})
    counts = []
    for r in REPEATS:
        n_sent, n_back = len(sent.findall(r)), len(back.findall(r))
        counts.append({'group': r, 'sent': n_sent, 'returned': n_back, 'survived': n_sent == n_back})

    ok = all(r['survived'] for r in rows) and all(c['survived'] for c in counts)
    for r in rows:
        print(f"{'OK  ' if r['survived'] else 'LOST'} {r['field']}: sent {r['sent']!r}, returned {r['returned']!r}")
    for c in counts:
        print(f"{'OK  ' if c['survived'] else 'LOST'} copies of {c['group']}: sent {c['sent']}, returned {c['returned']}")
    print(f"\n{sum(r['survived'] for r in rows)}/{len(rows)} fields and {sum(c['survived'] for c in counts)}/{len(counts)} repeat counts survived the round trip.")
    if out_json:
        with open(out_json, 'w', encoding='utf-8') as fh:
            json.dump({'templateDataVersion': version, 'fields': rows, 'repeats': counts, 'allSurvived': ok}, fh, indent=1)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
