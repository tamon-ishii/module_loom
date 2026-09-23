#!/usr/bin/env python3
"""Build a VSIX with only Python's standard library."""
import json
import shutil
import subprocess
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
extension = root / "plugins" / "vscode"
subprocess.run(["python3", str(root / "scripts" / "build_vscode_extension.py")], cwd=root, check=True)
manifest = json.loads((extension / "package.json").read_text(encoding="utf-8"))
output_dir = root / "target" / "vscode-extension"
output_dir.mkdir(parents=True, exist_ok=True)
output = output_dir / f"{manifest['name']}-{manifest['version']}.vsix"

identity = {key: escape(manifest[key], {'"': '&quot;'}) for key in ('name', 'version', 'publisher')}
display_name = escape(manifest['displayName'])
description = escape(manifest['description'])
vsix_manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="{identity['name']}" Version="{identity['version']}" Publisher="{identity['publisher']}" />
    <DisplayName>{display_name}</DisplayName>
    <Description xml:space="preserve">{description}</Description>
    <Categories>Visualization,Other</Categories>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" />
  </Assets>
</PackageManifest>
'''
content_types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="html" ContentType="text/html" />
  <Default Extension="md" ContentType="text/markdown" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
'''
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    archive.writestr('[Content_Types].xml', content_types)
    archive.writestr('extension.vsixmanifest', vsix_manifest)
    files = [extension / 'package.json', extension / 'extension.js', extension / 'README.md']
    files.extend(file for file in (extension / 'media').rglob('*') if file.is_file())
    if (extension / 'bin').exists():
        files.extend(file for file in (extension / 'bin').rglob('*') if file.is_file())
    for file in sorted(files):
        archive.write(file, 'extension/' + file.relative_to(extension).as_posix())
print(output)
