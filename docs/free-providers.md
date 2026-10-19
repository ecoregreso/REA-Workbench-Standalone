# Free providers and tool readiness

REA Workbench exposes all 170 tools advertised by REA 6.4.0. Availability depends on the selected provider, current target, host operating system, and inputs such as an authorized device serial or a browser CDP target. Open **MCP / Tools** to search the full catalog and inspect each input schema and requirement.

## Configure providers

Open **Settings**, choose an existing installation or executable, then **Reconnect engine**. Paths are saved separately for each application profile. Workbench does not write other agent clients' configurations. Native **Auto detect** prefers a configured Ghidra installation; an explicit Hopper or IDA choice still selects that provider.

| Provider | Purpose | Verified version | Requirements |
|---|---|---|---|
| [Ghidra](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.4_build) | Native decompilation and analysis | 12.1.4 | Extracted release and supported full JDK |
| [JADX headless MCP](https://github.com/1013503897/jadx-headless-mcp/releases/tag/v0.7.1) | APK metadata and Java code | 0.7.1 | Audited standalone JAR and full JDK |
| [Android platform tools](https://developer.android.com/tools/releases/platform-tools) | ADB device operations | 37.0.1 | Choose `adb`; device calls need their own device/serial inputs |
| [Apktool](https://github.com/iBotPeaches/Apktool/releases/tag/v3.0.3) | APK resources | 3.0.3 | Launcher and Java |
| [pwntools](https://pypi.org/project/pwntools/4.15.0/) | ELF layout and recorded crashes | 4.15.0 | Python environment with pyelftools 0.33 and Unicorn 2.1.2; REA adapter supports Linux x64 |
| [Wakaru](https://www.npmjs.com/package/@wakaru/cli/v/1.14.0) | Derived JavaScript source recovery | 1.14.0 | Native executable and `prlimit`; REA adapter supports Linux x64 |
| [Binwalk](https://github.com/ReFirmLabs/binwalk/releases/tag/v3.1.0) | Firmware signatures | 3.1.0 | Linux and `prlimit` |
| [Unblob](https://pypi.org/project/unblob/26.6.4/) | Firmware extraction | 26.6.4 | Linux, `prlimit`, and format-specific extractors |
| Chromium browser | JavaScript runtime resolution | Existing host installation | Choose executable; browser inspection additionally needs explicit CDP endpoint and target |

Choose the Python executable inside the pwntools virtual environment. Workbench preserves its invocation path because resolving its symlink to the system interpreter would lose that environment. For Wakaru, choose the native platform binary, rather than the npm JavaScript wrapper; REA runs it with a bounded address-space limit.

Providers are separate installations rather than bundled proprietary engines. The downloadable application supports Windows, macOS, and Linux; some upstream REA adapters remain limited to particular operating systems.

## Verified Linux readiness

With the free providers above configured, actual REA 6.4.0 sessions reported:

| State | Available | Target required | Other provider requirements | Unsupported host | Advertised |
|---|---:|---:|---:|---:|---:|
| No native binary opened | 97 | 59 | 5 | 9 | 170 |
| Owned ELF opened in Ghidra | 142 | 0 | 19 | 9 | 170 |

This is readiness evidence with valid inputs, not a claim that every available operation was executed. Real operation checks covered Ghidra procedure listing/decompilation, JADX APK inspection/method decompilation, pwntools ELF layout, ADB client inspection without contacting devices, Apktool client inspection, Wakaru recovery, Binwalk signature detection, and Unblob extraction with byte-exact fixture comparison.

The 19 entries outside the Ghidra session comprise four JEB tools, 13 interactive provider operations (navigation, comments, and bookmarks), navigation-context composition, and `trace_call_path`, for which upstream declares no provider composition in this session. Nine Apple-native utility operations require macOS. Licensed providers are not installed by this free-provider configuration, and unsupported operations retain their unavailable status.

REA 6.4.0 registers its 24 ADB and two Apktool handlers but omits their readiness from `binary_session`. Workbench performs the real `inspect_adb_client` and `inspect_apktool_client` probes once per connection and corrects only those omitted families after successful Evidence. Each tool retains `upstreamAvailability` and `readinessEvidence` so the original report and correction remain inspectable. The ADB probe neither contacts devices nor starts its server; device operations retain their actual prerequisites.

Some Unblob extraction formats require additional tools. Missing format-specific extractors do not imply that the tested gzip workflow failed or that all formats are supported.

## Selected scripts and portable sources

**Inspect target** accepts a selected JavaScript/TypeScript file, folder, or ASAR. A single script is copied byte-for-byte into an owned input directory with a synthetic package entry. Its original path, SHA-256, size, and selected-file-only scope are recorded separately from REA Evidence. Siblings and outside imports are not acquired; the code is parsed as inert text. The tool browser applies the same adaptation when analyzing the selected script directly.

Source preview works even when the engine returns no module graph. It shows bounded text while portable exports retain the exact selected bytes in `sources/` with provenance and the complete call/static-read records in `records/`. Changed snapshots are rejected before delivery or export. Large-file graph coverage and unresolved imports remain explicit in REA's result. Primary inspection exposes REA's `max_heap_mb` control: Automatic reserves three quarters of available host memory and caps the worker at 4 GiB; explicit 1/2/4/8 GiB choices are available. The upstream default is 1 GiB. A real 1.95 MB minified Cocos script exhausted that default during semantic analysis while preserving its static parse (593,364 AST nodes, 31 findings, zero parse failures); partial coverage must not be mistaken for an empty application. The same file also exhausted a 4 GiB semantic worker after 292 seconds; increasing memory alone did not complete its graph. Free Wakaru recovered one readable 4.89 MB derived source plus source map in 21 seconds, with no target execution and explicit unknown runtime equivalence.

Inputs for comparisons, imported evidence, APKs, and other local fields can be selected with native file/folder dialogs. These grants clear when changing targets or resetting the workspace. Output-directory fields receive unique defaults inside the application's owned output directory; tool outputs cannot overwrite the selected source. Use the report Export dialog to save portable assets elsewhere.

System health distinguishes the live Workbench connection from provider/environment checks and unrelated external-client registration audits. A failed aggregate doctor audit does not mean an already connected Workbench engine is offline.
