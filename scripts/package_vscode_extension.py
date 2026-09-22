#!/usr/bin/env python3
"""Build a VSIX with only Python's standard library."""
import json
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
extension = root / "plugins" / "vscode"
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
  <Default Extension="html" ContentType="text/html" />
  <Default Extension="md" ContentType="text/markdown" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
'''
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    archive.writestr('[Content_Types].xml', content_types)
    archive.writestr('extension.vsixmanifest', vsix_manifest)
    for file in (extension / 'package.json', extension / 'extension.js', extension / 'README.md', *sorted((extension / 'media').iterdir())):
        archive.write(file, 'extension/' + file.relative_to(extension).as_posix())
print(output)
