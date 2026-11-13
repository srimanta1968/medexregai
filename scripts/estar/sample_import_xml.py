"""
F5.4 eSTAR XML spike: write a sample import file for a manual round-trip check in Adobe Acrobat Pro.

    python scripts/estar/sample_import_xml.py <skeleton.xml> <values.json> <out.xml>

Starts from the blank template's own data DOM (xfa_catalog.py --skeleton) so every node the form
expects is present, then sets the values in values.json ({"Path/To/Field": "value"}; paths as in
the field catalog, without the data root). A path that is not in the skeleton is an error: the
form would ignore it silently. Values for radios, checkboxes and choice lists must be the SAVED
values from the catalog (e.g. "1"), not the captions.
"""

import json
import sys
import xml.etree.ElementTree as ET

# Keep the xfa: prefix the form uses on data-node attributes. Rich-text (xhtml) nodes are written
# with an html: prefix; the namespace is the same as the form's default-namespace markup.
ET.register_namespace('xfa', 'http://www.xfa.org/schema/xfa-data/1.0/')
ET.register_namespace('html', 'http://www.w3.org/1999/xhtml')

skeleton, values_path, out = sys.argv[1:4]
tree = ET.parse(skeleton)
root = tree.getroot()
values = json.load(open(values_path, encoding='utf-8'))
missing = []
for path, value in values.items():
    node = root.find('./' + path)
    if node is None:
        missing.append(path)
        continue
    node.text = value
if missing:
    sys.exit('not in the template data: ' + ', '.join(missing))
with open(out, 'wb') as fh:
    tree.write(fh, encoding='utf-8', xml_declaration=True)
print(f'{len(values)} values set -> {out}')
