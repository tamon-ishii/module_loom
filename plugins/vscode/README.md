# ModuleLoom for VS Code

Run **ModuleLoom: Open Module Graph** from the Command Palette in a Python workspace.
The extension runs `analyze --json` and opens the shared ModuleLoom interface. It supports automatic reanalysis, Git change and commit comparison, JSON analysis export, MkDocs export, and Ruff cycle-fix previews and application.

Ruff fixes use the project's `.venv` / `venv` or `PATH` installation. The preview is checked again before application, and the project is reanalyzed afterward. MkDocs output requires `mkdocs-material` when serving the generated site.

Build the analyzer with `cargo build --release --bin analyze` from this repository.
For other workspaces, set `moduleloom.analyzerPath` to the absolute path of that executable.

To package and install from this repository, run:

```sh
python3 scripts/build_vscode_extension.py
python3 scripts/package_vscode_extension.py
code --install-extension target/vscode-extension/moduleloom-1.0.5.vsix
```

Reload VS Code after installation.
