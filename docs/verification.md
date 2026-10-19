# Verification and release boundaries

## Standalone 0.2.0 cleanup

The local Linux checkout passed typechecking, all 24 tests, a clean production build, and the public source/application content gate. Tests include live REA analysis, evidence and Results retention, cancellation, file scope, child environment/profile isolation, packaged startup policy, renderer request policy, and release-content rejection cases.

A rebuilt Linux package connected its bundled REA 6.4.0 engine with 170 tools and passed JavaScript analysis, dossier export, Results import/preview/export and reset persistence.

The actual packaged Linux graphical app was launched in an isolated application-data directory with hostile development URL, profile and provider-registration environment variables. It loaded the bundled UI, used its own profile, retained renderer sandbox/context isolation, ignored the foreign provider registration, and connected its own engine. Renderer and Electron-session HTTP probes were rejected; the local probe server received zero requests. A health check did not report the foreign registration, and the foreign profile was untouched.

These observations cover the exercised Linux paths. The app and configured external providers run with the user's operating-system permissions; explicitly requested runtime inspection and network tools are not an operating-system sandbox.

## Release workflow and other platforms

The release workflow checks source/build output on Linux x64, Windows x64, Intel macOS x64 and Apple Silicon macOS arm64. It packages each platform and exercises the packaged engine before uploading candidates. Packaged smoke checks also validate the app's own distributed files.

Windows/macOS packages and graphical behavior for this cleanup have not been rebuilt or exercised locally. Run the native matrix and graphical acceptance on those systems before claiming platform verification. Presence of installer configuration does not prove a built, installed or signed application.

Publisher signing and notarization require configured credentials and separate verification. A checksum identifies bytes; it does not establish publisher trust. Draft release creation does not publish a release or change repository visibility.

Cleaning source does not remove older hosted commits, tags or release assets. Use the history-free checked source export for a fresh public repository, or separately sanitize the old hosted repository before making it public. See [local data and public source](privacy.md).

## Provider limits

Native decompilation needs an installed/configured provider. Go uses native-provider symbol/code analysis. Android and other advanced workflows require their own provider prerequisites. A tool in the catalog is distinct from provider availability and successful execution. This release does not claim tested execution of every adapter or universal subsystem access.

An ordinary browser cannot access local targets or REA. These operations require the standalone desktop preload/main bridge.
