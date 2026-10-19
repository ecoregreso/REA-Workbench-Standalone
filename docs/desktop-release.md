# Desktop release workflow

The desktop application is packaged on native Linux, Windows, and macOS runners. Every matrix job installs the committed lockfile with `npm ci`, uses Node 22.19.0, runs the tests, builds the application, checks public release contents, then packages its own platform. The workflow pins GitHub actions to reviewed commit hashes and disables electron-builder publishing.

| Runner | Architecture | Download formats |
| --- | --- | --- |
| Ubuntu 24.04 | x64 | AppImage and tar.gz |
| Windows Server 2025 | x64 | Setup installer and portable executable |
| macOS 15 Intel | x64 | DMG and ZIP |
| macOS 15 Apple Silicon | arm64 | DMG and ZIP |

Manual runs upload release candidates to the workflow run. A matching `v<version>` tag also assembles a **draft** GitHub release after every platform succeeds. A tag must match `standalone/package.json`. The workflow refuses to overwrite a published release. Public prerelease promotion follows review of the native build and packaged-runtime evidence. Stable release promotion also requires graphical installation and user acceptance on each supported operating system.


## Signing modes

The default produces candidates without publisher signing credentials. Windows and Linux outputs are unsigned. macOS outputs receive an ad hoc signature so their structure remains usable on Apple Silicon; they have no Developer ID publisher certificate and are not notarized. Each platform writes a `BUILD-<platform>-<arch>.json` identifying that state and a SHA256SUMS file identifying the actual installer bytes. Neither a successful build nor a checksum establishes publisher trust.

For a manually requested signed run, select the workflow's **sign** input. For signed tag builds, set the repository variable `REA_SIGN_RELEASES=true`. Configure these repository or environment secrets before using either option:

| Secret | Purpose |
| --- | --- |
| `WINDOWS_CSC_LINK` | Windows publisher PFX/P12, preferably a base64 encoded certificate |
| `WINDOWS_CSC_KEY_PASSWORD` | Password for the Windows certificate |
| `MACOS_CSC_LINK` | macOS Developer ID Application P12, preferably base64 encoded |
| `MACOS_CSC_KEY_PASSWORD` | Password for the macOS certificate |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App specific password for that account |
| `APPLE_TEAM_ID` | Developer team identifier |

Signed Windows jobs require valid Authenticode signatures on both installers. Signed macOS jobs require a valid bundle signature and a stapled notarization ticket. Missing required secrets or failed verification fails the job. Linux packages are recorded as unsigned in both modes. Secrets are supplied only to their platform's packaging step and must never be committed to source.

## Graphical acceptance before stable publication

Download the candidates and check their SHA256SUMS files. On each supported operating system, install or extract the application, connect its embedded REA engine, run Diagnostics, open a representative target, execute an applicable tool, inspect its live output, and export a dossier. Exercise cancellation and closing the app, then confirm its owned analysis process exits. Check provider readiness on that machine; Ghidra, Android tools, native debuggers, and other external providers remain separate capabilities with their own requirements.

Native runner smoke tests connect the packaged Electron Node runtime to the bundled engine and exercise analysis and dossier export. They confirm those engine operations on each host. Graphical installation, interactive OS dialogs and user acceptance on Windows/macOS remain separate checks; record that evidence before marking a release stable.

The [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) documents the native runner labels. The [electron-builder signing guide](https://www.electron.build/code-signing.html) documents certificate environment variables; the project's pinned electron-builder version remains the implementation authority for packaging.
