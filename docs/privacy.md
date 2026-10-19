# Local data and public source

The desktop app starts its own REA child over stdio. It has no account bridge, shared session, telemetry client, automatic upload or background sync. Results, evidence, provider choices and temporary files stay in its own REA Workbench profile. Another application's analysis directory is never automatically imported.

REA children receive a small operating-system environment allowlist and the provider settings explicitly selected in this app. Ambient provider registrations, agent credentials, proxy configuration and Node startup hooks are not inherited. Provider discovery and health checks use a separate `engine-home` directory under this app's analysis directory, rather than the user's actual home or other apps' configuration roots.

Packaged apps always use the REA Workbench application-data directory and bundled UI. Development profile and URL overrides are supported only in source development. The sandboxed renderer can load bundled UI assets and data images; its session blocks HTTP, WebSocket and other network requests. Source development permits only the exact loopback development server origin. New windows, webviews, navigation and downloads are blocked.

Explicitly requested analysis tools can inspect selected files, attach to a specified runtime or device, or use a provider the user configures. These operations run with the user's operating-system permissions. The engine and third-party tools are not a security sandbox. Provider selection and target selection remain deliberate user actions. Reports and Results exports contain the chosen analysis data; share them deliberately.

## Release contents

Run `npm run build` followed by `npm run check:release`. The check rejects retired integration references, personal absolute paths, common credential material, unreviewed files, source symlinks and application source maps. Builds clean their generated directories before writing new output. The native release workflow runs the same checks, and packaged smoke checks recheck the shipped app files.

`npm run export:public` creates a checked source archive in `release/`, with a SHA-256 sidecar. The export includes reviewed application source, dependencies' lockfile, build scripts, documentation and tests. It excludes Git metadata/history, installed dependencies, generated apps, local profiles, private QA material and the unactivated license draft.

Cleaning a working tree does not erase old Git commits, tags, hosted release attachments or previous downloads. Publish from the checked source archive into a fresh repository/history, or separately replace the old hosted history and release attachments before changing repository visibility. Previously distributed copies cannot be recalled by a local cleanup.
