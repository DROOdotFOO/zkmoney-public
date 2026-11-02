# Web-wallet UI captures

`pnpm ui:capture` runs a dedicated Vite development server and captures the real wallet routes with local demo fixtures. It requires the repository dependencies, built workspace packages and a Playwright Chromium installation. It does not require a personal skill installation, a config service, or a sandbox. The existing `pnpm test:e2e` command continues to run a production build against the live sandbox.

From `packages/web-wallet`, prepare dependencies using the repository's normal contract/artifact setup, then build `../sdk`, `../config-client`, and `../front-core` with `pnpm build`. Install the browser with `pnpm exec playwright install chromium` if it is not already present. Use `--browser-cache /path/to/ms-playwright` to select an existing cache when `PLAYWRIGHT_BROWSERS_PATH` points elsewhere.

```sh
pnpm ui:capture --path / --scenario activity --preset 390x844
pnpm ui:capture --plan scripts/ui-capture/plans/drawer.json --preset all
pnpm ui:capture --plan scripts/ui-capture/plans/registration.json --preset all --record
pnpm ui:capture --plan scripts/ui-capture/plans/create.json --viewport 600x844
pnpm ui:capture --plan scripts/ui-capture/plans/home.json --viewport 1280x832
pnpm ui:capture --plan scripts/ui-capture/plans/registration.json --safe-area 20,12,34,12
pnpm ui:capture --scenario fresh --path /withdraw?cap=review --path /withdraw?cap=done --viewport 402x874,1280x832
```

Each run starts a Vite server, a browser and the app, which costs about 20 seconds before the first screenshot. Capture several states in one run: repeat `--path`, and list the sizes in `--viewport`. Each extra route costs one page load, about 5 seconds. Each route is saved as its own file, for example `402x874/withdraw-cap-review.png`. A single `--path` keeps the name `final.png`. Several `--path` values cannot run plan steps.

The command owns its loopback server and stops it afterward. Port 5499 is the default; choose another with `--port`. An occupied port fails rather than reusing an unrelated server. Local `.env` files and ambient `VITE_*` settings are excluded. The server serves a synthetic config profile through the normal config-client validation path, and its `/svc/*` proxies are disabled.

## Viewports and output

The phone presets are **390×844**, **402×879**, and **390×667** CSS pixels. `--preset all` runs each in a separate clean browser context. `--viewport WIDTHxHEIGHT` supports breakpoint and desktop checks, and a comma-separated list runs each size in turn. These dimensions describe the browser content viewport. They do not include a device frame, address bar, share strip, browser toolbar, or report captions.

Screenshots capture the visible viewport by default. Use `--full-page`, plan `fullPage: true`, or screenshot-step `fullPage: true` for supplemental scroll content. This does not change the viewport recorded in the report. Each viewport has its own directory containing screenshots and `report.json`; the parent `report.json` collects the batch. The default output is a unique directory under the system temporary directory. `--output-dir` must point outside the repository and be new or empty. Source destinations are rejected before creating directories. Symlinked descendants and existing output files are rejected, so reruns need a new directory and screenshot steps need unique filenames.

`--record` requires `ffmpeg` and `ffprobe`. The final WebM preserves the CSS viewport, including its last row and column at odd dimensions. The runner samples viewport PNG frames at a target interval of 200ms, checks each frame size, and encodes VP9 with 4:4:4 chroma without cropping or resizing. Frame durations follow elapsed capture time; slower screenshots reduce the sampling frequency. A transient inactive-renderer error during navigation is retried up to nine times at 100ms intervals, with the count recorded as `captureRetries`; other recording errors fail the run. Reports record the method, frame interval, frame count, elapsed duration and video start offset (`videos[].at`, relative to the run). Subtract that offset from screenshot or step timestamps to seek within the recording. These recordings show interaction states, not animation performance, and contain no page captions. Recording runs hold each screenshot state for 1500ms before continuing; set plan `recordHoldMs` between 0 and 10000 to adjust this. Startup and route-loading frames remain in the recording. Report screenshot and step timestamps provide an approximate interaction timeline outside the measured app area.

For a Figma comparison, crop the reference to its app-content region and record the corresponding CSS content viewport separately. Keep the three presets as responsive regression checks. Do not compare an entire Figma device frame directly to a CSS viewport screenshot or subtract a fixed browser-toolbar height from production layout.

## Fixture and interaction plans

`activity`, `fresh`, `empty`, and `recovery` use typed store fixtures. `empty` seeds zero balance and no feed records; its DEV-only asset mount supplies the zero display asset that cache hydration normally omits. It does not mark balances as live or authorize transactions. `fresh` retains its funded balance for flow previews. `onboarding` primes the local Oxide config without seeding an identity or installing a wallet provider. Combine it with the existing `/claim?mock=create|claiming|deposit|funded` states. The phone shell interface and inferred composition are documented in [MOBILE_SHELL.md](../../MOBILE_SHELL.md). `shell.json` covers search, Pending, menu scrolling and View all; `home-empty.json` covers the zero-balance deposit prompt. The checked-in plans also capture Home, the drawer, the create variant and educational banner, the paylink amount sheet, registration's scrollable card, standard claim retry and transaction detail. `phone.json` runs the core phone sequence; `responsive.json` omits drawer actions for wider viewports; `insets.json` adds the remaining sheet variants and nonzero inset overrides. They use real controls and page components. Paylink submission and real registration remain integration checks.

All demo activation remains guarded by `import.meta.env.DEV`. The runner fixes browser `Date` to `2026-09-01T12:00:00.000Z`, uses UTC and `en-US`, waits for the expected content and loaded fonts/images, and captures with a hidden caret and completed CSS animations. `--fixture-time` can select another fixed instant; it is recorded in the report. Timers continue running so navigation and mock transitions work.

A plan is a JSON object. CLI values override corresponding plan values:

```json
{
  "scenario": "activity",
  "path": "/links/new",
  "ready": { "label": "Amount" },
  "steps": [
    { "action": "fill", "label": "Amount", "value": "12" },
    { "action": "screenshot", "file": "amount.png", "state": "Paylink amount entered" },
    { "action": "reachable", "role": "button", "name": "Next", "exact": true }
  ],
  "finalScreenshot": false
}
```

Supported plan fields: `scenario`, `bootstrap`, `path`, `ready`, `steps`, `preset` or `viewport`, `state`, `finalScreenshot`, `fullPage`, `record`, `recordHoldMs`, `colorScheme`, `fixtureTime`, `safeArea`, `timeout`, `rejectingExtension`, and `blockedProxyPrefixes`. `safeArea` is a comma-separated top/right/bottom/left pixel string, matching the CLI. `ready` is a locator required before any steps run; `--ready` accepts a CSS selector for direct captures. Screenshot `state` identifies the interaction state in the report.

Locators support `role` with optional `name`, `label`, `text`, `testId`, `placeholder`, or `selector`. Add `exact`, `first`, or `nth` when needed. Prefer accessible roles and labels.

Actions: `goto` (`path`), `reload`, `back`, `click`, `fill` (`value`), `press` (`key`), `hover`, `check`, `uncheck`, `select` (`value`), `waitFor` (optional visibility `state`), `waitForUrl` (`url`), `wait` (`ms`), `scroll` (`top`, a number or `"end"`), `reachable`, and `screenshot` (`file`, `state`, optional `fullPage`). `reachable` scrolls a control into view and performs Playwright's trial-click checks without activating it. Viewport changes inside a plan are rejected; run a separate capture for each size.

The browser guard blocks external HTTP, unmocked `/svc/*` requests, external/proxied WebSockets, service workers, and server redirects. It permits local assets and Vite HMR. A blocked service attempt is a fixture failure: fix the fixture at the existing service boundary, do not treat the aborted request as a successful capture. Reports must have `ok: true` and empty verification-error arrays. Console errors, page errors, request errors and failed steps also fail the command. Browser guards do not isolate Node-side plugin behavior; the capture server uses the repository's asset/build plugins and does not start backend processes.

## Controlled camera inputs

Scanner plans can set `camera: { "state": "denied" | "pending" | "unavailable" | "live", "payload"?: "wallet payload", "torch"?: true }`. The runner installs controlled `getUserMedia` before bootstrap. A live fixture uses a canvas video stream and a QR generated by `uqr`; the wallet still loads and runs its bundled decoder. Omit `payload` to capture the active viewfinder before detection. This verifies browser rendering, decoder integration, and resource cleanup. It does not verify a physical camera, browser permission UI, or the deployed response policy.

Camera steps use `action: "camera"` and `operation: "grant"`, `"deny"`, `"payload"`, `"end"`, or `"assertStopped"`. The payload operation takes a string `value`; an empty string removes the code. Grant and deny settle controlled unanswered requests. End stops the fixture tracks and dispatches the camera-ended event. AssertStopped fails if a returned stream still has a live track; grant a pending request after closing the scanner before asserting late-permission cleanup. Camera configuration is recorded in the capture report. Keep real private payloads out of demo plans.

Set `camera: { "state": "live", "torch": true }` for a controlled torch-capable stream. It advertises the standard track capability and records requested on/off constraints; it does not change production capability checks or operate a physical light. Use the existing buttons `Turn flashlight on` and `Turn flashlight off`. Fixture stats include `torchChanges` and `activeTorchTracks`; stopping the stream clears its simulated torch. Omitted or false `torch` keeps the default capability absent.

```json
{
  "scenario": "activity",
  "camera": { "state": "live" },
  "steps": [
    { "action": "click", "role": "button", "name": "Scan QR code", "exact": true },
    { "action": "screenshot", "file": "scanner.png", "state": "Controlled camera active" },
    { "action": "camera", "operation": "payload", "value": "@ada" },
    { "action": "waitForUrl", "url": "**/contacts/ada" },
    { "action": "camera", "operation": "assertStopped" }
  ]
}
```

## Phone CSS conventions

Phone means viewport width **≤640px**, expressed with ordinary `@media (max-width: 640px)` rules in `src/ui/shell.css`. The 960px onboarding and 1180px wider-layout cutovers retain their existing behavior. CSS custom properties are not used in media-query conditions.

Shared `--ww-safe-area-top`, `--ww-safe-area-right`, `--ww-safe-area-bottom`, and `--ww-safe-area-left` tokens read the browser's `env(safe-area-inset-*, 0px)` values. Each surface owns its own inset; do not add a body-level inset and then add it again to a fixed overlay. `viewport-fit=cover` is already declared in `index.html`.

| Surface | Ownership |
| --- | --- |
| Standard sheet | Shared modal owns base bottom padding plus the bottom token. |
| Create, payment, transaction detail | Keep their `--sheet-pad-bottom` base override; shared modal adds the bottom token once. |
| Registration | Inner card owns base content padding and scrolling. Outer sheet owns only the bottom inset, keeps `overflow: hidden`, and preserves its specialized height cap. |
| Phase 2 header | Apply the top token once at the outer header and horizontal tokens at the content edges. Avoid repeating them in the identity/search rows. |
| Phase 2 primary menu | The independent fixed menu owns its top/right/bottom/left tokens; its content does not inherit a second inset from the page. |

Phase 1 defines all four tokens and converts the existing sheet inset. Header/menu placement and any additional edge treatment belong to phase 2. The browser's bottom toolbar is outside the wallet: no fixed toolbar allowance or new app bottom navigation is introduced.

Viewport-dependent sheet heights use `dvh`. Preserve standard desktop/phone caps and specialized registration constraints; do not replace every sheet's height with the same value. Search uses `60dvh`. Static screenshots and `dvh` do not prove that an open keyboard leaves controls reachable.

## Verification

Use the same fixture clock, state, and viewport for before/after comparisons. Capture Home, drawer, create/paylink and registration at all three presets; test widths 559, 560, 561, 600, 639, 640, and 641px, plus desktop at 1280×832. The intended spacing changes above 560px through 640px are create padding from `40px 64px` to `32px 24px` and educational-banner padding from `10px 66px` to `10px 24px`. Registration removes duplicate outer base padding while preserving the inner card's base padding. Record any other intended safe-area or dynamic-viewport correction with the evidence.

Repeat representative captures with `--safe-area 20,12,34,12`. This overrides the shared CSS tokens and Chromium's underlying `env(safe-area-inset-*)` values, so the same command can compare older direct `env()` rules with token-based rules. Reports include each sheet's computed padding, height constraint and scroll dimensions, which help identify doubled padding. Check standard, create, payment, transaction-detail and registration variants; scroll to the final controls and verify their reachability. Repeat under `--color-scheme light` and `dark`; the product remains dark-only.

Run `pnpm test:ui-capture` to check request isolation, output containment, and decoded video edge pixels as well as dimensions. It requires Chromium, ffmpeg and ffprobe. Run the focused demo tests and `pnpm build` after changing demo integration or product CSS.

On actual iOS Safari and Android Chrome, record device model, OS/browser version, orientation, visible content dimensions, keyboard open/closed behavior, expanded/collapsed browser toolbar, scrolling, final-control reachability, and close/back/focus behavior. These results are separate from headless demo evidence and transaction integration. Record unavailable checks as pending, not passed. Defects requiring later layout work need an explicit owning phase and remain part of ULT-779's final sign-off; acceptance-blocking defects must be resolved and rechecked.

Run `pnpm test:scan-qr` for the production Share card corpus through the scanner decoder. This explicit browser suite requires Chromium and is excluded from `pnpm test`. Its temporary report records complete payloads, source and PNG hashes, and exact decode results. `pnpm test:ui-capture` also checks the bundled decoder worker against controlled canvas media under COOP/COEP, including stream release after a late permission grant. Neither suite establishes physical camera compatibility.

See the [flow capture plans](./plans/flows/README.md) for the flow-specific fixture interface.
