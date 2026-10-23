"""Check the exact vendored decoder inputs before embedding/building them."""
from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[1]/'web/vendor/broadway'
manifest=json.loads((root/'provenance.json').read_text())
for name,record in manifest.items():
    assert Path(name).name==name
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==record['sha256'],name
assert (root/'LICENSE.tesla-android').is_file() and (root/'LICENSE.Broadway').is_file()
print('PASS: pinned browser decoder hashes and license files')
