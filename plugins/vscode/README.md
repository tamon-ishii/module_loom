# ModuleLoom for VS Code

Run **ModuleLoom: Open Module Graph** from the Command Palette in a Python workspace.
The extension runs `analyze --json` and opens an interactive dependency graph.
Click a module or import to open its file in the editor.

Build the analyzer with `cargo build --release --bin analyze` from this repository.
For other workspaces, set `moduleloom.analyzerPath` to the absolute path of that executable.

To package and install from this repository, run:

```sh
python3 scripts/build_vscode_extension.py
python3 scripts/package_vscode_extension.py
code --install-extension target/vscode-extension/moduleloom-0.1.0.vsix
```

Reload VS Code after installation.
