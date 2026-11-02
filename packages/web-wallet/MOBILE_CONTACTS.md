# Mobile Contacts

ULT-783 uses the existing contact directory, registry lookup and fresh verification before saving. At phone widths, Contacts owns its centered back/title row and search; `App.tsx` opts exact `/contacts` into `SidebarLayout.mobilePageHeaderPaths`. The page follows the 80px reference header and 24px horizontal insets, with safe areas applied once by its outer content container. It scrolls naturally without a fixed header-height subtraction. The existing background glow is positioned for the Contacts content frame. Desktop keeps its existing header, search and directory layout. A one-shot `/contacts` route state `{searchTag: normalizedTag}` prefills and focuses the existing search, then removes only that key with a history replacement. Saving still requires an explicit Add. The shared search shows local matches, lookup progress, an explicit Add action for an unsaved result, and a not-found state. Add remains busy through fresh verification. Verification errors stay next to the result for retry, and editing or dismissing a search invalidates its pending navigation and verification.

On phones, incoming notification toasts do not appear while Contacts owns the header; persisted notifications remain accessible through the shell bell on other routes. Locked Contacts retains the shell brand lockup and menu until unlock.

## Web Figma phone geometry

The Contacts reference is web-wallet node `10231:67168`, a 402×678 content frame without browser chrome. The phone page uses an 80px title row, 24px content insets, a 44px search field, 8px between each section label and card, and 8px between sections. Cards keep 12px padding and 16px row gaps; ordinary rows are 52px tall with a 44px avatar and a 28px initial. Long names can increase a row's height. The search placeholder is 14px; the input remains 16px to avoid phone focus zoom. These geometry styles are scoped to Contacts and do not alter the shell's expanded search. Both phone search consumers use the web Figma search glyph; only `.ww-search__suffix` is hidden on phones. Desktop keeps its original glyph and suffix.

The optional trailing action sits immediately after `TagSearchBar` inside `.ww-contacts__search`. The wrapper has one flexible column until `.ww-contacts__search-action` is present, then uses `minmax(0, 1fr) 44px` with an 8px gap. Search results remain in the first column and the action stays at the input's top edge. ULT-785 supplies the guarded `Scan QR code` button and its focus-return reference; it also removes the extra title-row Share action. Keyboard order follows the input and then Scan. Existing blur/outside cancellation and one-shot destination search focus remain in place.

The Contacts background reuses the exact web Figma circle artwork, preserving its intrinsic filter bounds inside the 1280×749 reference frame instead of stretching the SVG to that frame. This adjustment applies only while the Contacts page is present. Desktop and other flow backgrounds retain their existing styles.

Phone controls consume the shared `PhoneIcon` assets without changing design-system defaults. Contacts keeps a 44px Back hit target with a 40px visible circle and uses a 24px back glyph, 18px search glyph and 16px row chevrons.

## Activity recency

The web activity subscription hydrates the existing account stores, follows their change events, rejects stale overlapping reads and removes listeners on unmount. `recentContacts` in front-core selects up to three saved contacts by their latest recorded interaction. It uses transfer timestamps, contact-request creation times and bridge start times. It matches L2 addresses or normalized tags, and matches current L1 addresses using the same provider rule as contact storage: generic or missing providers match a known provider; distinct known providers remain separate. It excludes unknown contacts, cancelled requests, locally cancelled transfers without a transaction hash and unfunded SIPA deposits. A directory without activity has no Recent section. Completion and polling times do not move a contact forward.

## Demo fixtures

The repository capture plans use local data and block external services. Run them from `packages/web-wallet` with `pnpm ui:capture --plan scripts/ui-capture/plans/<name>.json --preset all --port 5783 --browser-cache /path/to/ms-playwright`.

| Plan | Data and states |
| --- | --- |
| `contacts-empty` | Fresh wallet without contacts |
| `contacts` | 26 contacts, long L1 and L2 labels, recorded activity and scrolling |
| `contact-search` | Local, lookup, resolved, not found, fresh verification busy/error/retry and save |
| `shell-contact-search` | The same lookup and save states through the expanded shell search |
| `contact-search-races` | Edit during verification, address mismatch and Escape dismissal |

Capture reports establish local rendering and navigation. Physical iOS Safari and Android Chrome keyboard/toolbars and design review remain external acceptance checks.

The input label is `Search @tag`, the result region is `Contact search results`, and the explicit save action is `Add contact @<tag>`. The field keeps 16px text on phones to avoid focus zoom; Scan is supplied by ULT-785 when functional. Existing L1 names and L2 tags remain searchable.

Validation before the design-fidelity correction passed 1,043 web unit tests, 12 front-core recency tests, package builds and web typecheck. Capture reports must be checked for `geometry.scrollWidth <= viewport.width` in addition to the harness `ok` field, which covers service and console failures.

The design-fidelity integration passed 1,058 wallet unit tests, 12 front-core recency tests and web typecheck.
