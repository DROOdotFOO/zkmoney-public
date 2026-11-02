# Flow capture plans

Run these plans with `pnpm ui:capture --plan scripts/ui-capture/plans/flows/<name>.json --preset all --record`. Add `--browser-cache`, `--port`, and a new `--output-dir` for the local environment. Run the same plans at 1280×832 and with `--safe-area 20,12,34,12`; use separate runs for breakpoint and light-browser checks.

Plans with transient service states set `recordHoldMs: 0`, preserving their explicit waits when recorded. Screenshot capture itself still takes time, so state labels describe the expected simulation step; inspect the image and timeline before asserting it.

These captures show the production components, route guards, navigation, packet codecs, and public stores with simulated service responses. They do not execute a passkey ceremony, prove a transaction, submit to a chain, deliver an XMTP message, or register a real name. A screenshot that says “Sent” is a simulated result, not evidence of transaction completion.

| Plan | Coverage |
| --- | --- |
| `send.json` | Amount and note, confirmation with the keep-open note, simulated signing, the hand-off to the bell and its running row, simulated result. |
| `send-retry.json` | Failed service response, reportable error above the send sheet, dismissal, retry and handoff. |
| `send-post-signing-failure.json`, `withdraw-post-signing-failure.json` | Simulated submission failure after the hand-off to the bell; the failure lands only on its notification row. |
| `send-cancel.json` | Cancel before proving begins; the service reaches the existing cancellation callback. |
| `withdraw.json`, `withdraw-retry.json` | Recipient and alias, amount and fee, confirmation with the Standard/Faster speed choice, simulated signing, the hand-off to the bell and its running row, failure and retry. |
| `deposit.json` | Privacy notice, generated address and nested QR, one-time warning, connected-wallet amount/review, simulated submission and persisted pending deposit detail. |
| `withdraw-swap.json`, `withdraw-quote-states.json` | Output asset selection, illustrative quote, amount/review, simulated withdrawal handoff, loading and unavailable estimate. |
| `withdraw-limits.json` | A 10,000 balance: the per-withdrawal limit before typing, MAX at 5,000, one cent over with the limit notice and its disabled action scrolled into view, and Enter on "Use maximum" and "Withdraw funds" reaching the review at the limit. |
| `withdraw-unavailable.json` | A swap route the screen cannot price is closed before any amount: the warning and a disabled Continue. |
| `deposit-desktop-unresolved.json` | Desktop-bridge mode with discovery's unfunded record for the published address. An approved send without a hash pauses funding and hides the address; the hold is kept after leaving and returning in the app, and "Start a new deposit" shows a different address. |
| `deposit-desktop-unresolved-funded.json` | The same hold, then a funded record for the address ends it and opens the deposit detail. |
| `limits-usdc-over.json` | USDC one cent over the $5,000 gross limit with its disabled action scrolled into view; Enter on "Use maximum" clears the limit, and with the conversion credit unknown nothing is said about capacity and Deposit funds is available. |
| `limits-clock-ahead.json` | A device clock ahead of the chain head: the capacity read looks old, so capacity is unknown; nothing is said and Deposit funds stays available. |
| `limits-keyboard-retry-recover.json` | Enter on About limits' Check again after a failed original-portal lookup, and Enter on a recoverable deposit's Recover. |
| `limits-registration-origin.json` | An earned registration held by its original portal's empty bucket while the active bucket has room; the funding panel and the wait's details name the original bucket. |
| `receive.json` | Create a request link from Receive, persist its real request row, and inspect share/details and final controls. |
| `request-contact.json` | Contact request confirmation, simulated delivery, and real navigation to the conversation. |
| `paylinks.json` | Amount, note, options, voucher check, confirmation and simulated link creation. The prepared hashless link opens pending details before signing finishes; the same public-store row later supplies the illustrative funding hash and settled URL. The cancel-link recovery sheet remains reachable. |
| `paylink-claim.json` | Real signed-in `/link` to Home handoff, claim prompt, simulated signing, the hand-off to the bell, the Received notification and terminal transaction details using the stored claim hash. |
| `visitor.json` | Identity-free `/link`, voucher choice, accountless ClaimToL1 recipient/review/working, persisted withdrawal display, claimed/no-voucher/email variants. |
| `requests-public.json` | Identity-free `/request`, external-wallet sheet and nested QR, retry, warning, terminal error, expired/wrong-network/wrong-token, legacy/malformed and any-amount packets, and loading. |
| `requests-wallet-problems.json` | Wallet loading, expired/wrong-network/wrong-token/malformed packets and network lookup error. |
| `requests-small.json` | The external-wallet fee-exceeds-request warning. |
| `requests-wallet.json` | Signed-in `/request` validation and navigation into the existing send confirmation, followed by a simulated send. |
| `registration.json` | Persisted pending registration, free/paid, expired reservation, wrong network, retry/checking, short deposit and passkey notice variants; existing creating/claiming/funded previews. |
| `feedback.json` | Bug report form, submitting, failure, retry, success, dismissal and Settings return. |
| `conversations.json` | L2 history and incoming and outgoing request details, cancel confirmation, reachable Send/Request actions, L1 history/actions and withdrawal prefill. |
| `panels.json` | Send, receive, withdrawal entry, conversation, Settings, feedback and registration panel geometry. |
| `deposit-processing-blocked.json` | Pending deposits against an empty capacity bucket: the activity rows, the detail sheet's reason block, and Recover opening the recovery-only sheet with no sweep offered. |
| `deposit-processing-fresh.json` | A fresh USDC deposit with enough capacity: its row, detail sheet and bell live row keep their phase wording, with no delay reason. |
| `deposit-recovery-reveal.json` | A recovery-only sheet opened against an empty bucket offers Sweep now once Check again reads capacity; a deposit over the network's per-deposit maximum stays recovery-only. |
| `registration-earned-blocked.json` | An earned registration whose broadcast is spent, funded and held by capacity: the manual sweep action states its reason and Check again. |

## Layout decisions

Entry pages keep their existing routes. At phone widths, panels use the shell's intrinsic header and document scroll. They no longer cap their content with a fixed 210px header subtraction. Confirmation, working, feedback, logout and recovery steps use the shared native bottom sheet. Long sheets scroll internally, keep their close/back rules, and apply the shared safe-area tokens once. Registration retains its inner scrolling card and persistent overlay across step changes. Share @tag keeps its separately designed inset presentation and direct overlay-to-card structure.

Native modal dialogs make the background inert and keep nested sheets in top-layer order. Escape closes only the top eligible sheet; busy operations retain their existing dismissal guards. Native closing restores the prior focus. Cleanup preserves any destination that took focus before the old dialog closed; a fallback supports dialog shims. Native close events reconcile React state; busy frames and frames retained across step changes reopen, while delayed cleanup events are ignored. Explicit `data-autofocus` inputs and `ww-autofocus` TextField wrappers restore initial field focus after native opening; other cards keep their default focus. Document scroll locking follows the presence of open shared dialogs, so closing one overlapping sheet does not release another sheet's lock.

Overlay taps and Escape follow the same action as the visible X on dismissible send and paylink steps. Onboarding registration steps stay open on overlay taps and Escape; their Close control dismisses them. Busy steps keep their existing close guards. This is an inferred interaction decision for design review, alongside the inferred flow layouts. Phone conversations use document scrolling and open at the newest messages with their footer actions visible, or at the last message when no actions are available. Phone Notifications uses the shared native sheet, with an internal scrolling list, wrapped descriptions, and a close control. Desktop keeps its anchored panel. Browser checks cover Notifications at 639/640/641px and Menu→Share/Logout on the manager-restacked 782/783 base. Physical keyboard/toolbars, design approval and live transaction completion are separate from these local captures.

## Service controls

The capture server installs `flow-fixtures.mjs`; normal Vite development and production builds do not import it. The plans use the existing activity, fresh, recovery and onboarding demo scenarios. Fixture wrappers delegate to the original service when no control is active. Unimplemented contract calls fail explicitly, and browser isolation continues to reject external traffic and unmocked `/svc` requests.

`flowFixture` is latched in this clean browser context's session storage so real in-app navigation preserves the selected response. `flowFixture=off` removes it. Use a new context for a fresh attempt counter.

| Value | Service behavior |
| --- | --- |
| `success` | Delayed successful response. Send, withdrawal, paylink creation and claim emit simulated signing events and update public stores. |
| `retry` | The first named operation fails; the next succeeds. Feedback and accountless request resolution use the same first-failure behavior. |
| `post-signing-failure` | Fail submission after simulated signing ends, once the modal has handed the transaction to the bell. |
| `failure` | Operations fail before simulated signing. |
| `signing` | Hold the simulated signing step open. |
| `signing-failure`, `signing-retry` | Emit a failed signing-end event and reject; the retry variant succeeds on the next named attempt. The production failed-signing guard keeps the prompt available. |
| `no-signing` | Finish without a signing ceremony, exercising the production settlement fallback. |
| `pending` | Hold the operation after signing: the modal hands it to the bell, which keeps the tab-bound ring. |
| `loading` | Hold public request network lookup or paylink status/voucher lookup. The production voucher timeout still applies. |
| `no-voucher` | Return zero cash-out uses and an unavailable create voucher. |
| `claimed` | Return a claimed paylink status. |
| `terminal` | Return the accountless request's nonretryable registration failure. |
| `warning` | Return an accountless request result with a warning. |

`flowEntry=visitor|visitor-email|request|request-small|request-any|request-expired|request-network|request-token|request-legacy|request-invalid` constructs a packet using the public SDK/front-core codec during bootstrap and replaces the URL with the corresponding real `/link#…` or `/request#…` route. `request-legacy` uses a fixed v1 codec test vector; `request-invalid` supplies an intentionally unreadable fragment. This initial packet construction is seeded; clicks, nested sheets, validation and navigation after it are real. The visitor plans use `demo=onboarding`, which starts with no wallet identity. The fixture installs the existing fake L1 reader without creating an account.

`registrationFixture=awaiting|free|expired|wrong-network|retry|short|passkey-mismatch|passkey-unavailable|funded|swept` seeds a typed `PendingRegistrationRecord` and registration terms, reserved for seven days (`expired`: already over), through the existing stores. `funded` and `swept` add the funded or swept stamp. `identityFixture=pending` marks the seeded wallet identity as still registering, so Home shows the registration surfaces (`registration-stages.json`). `nameFixture=available|reserved|blocked|blocked-reserved|unknown` answers the open name-availability probe (`search-reserved.json`). Use it on `/claim?demo=onboarding&flowFixture=success` without `mock`. `Check again` invokes the real page handler against a simulated detection service. Retry notice plans invoke the real retry handler against a simulated passkey failure. Existing `mock=creating|claiming|funded` states remain explicitly seeded previews.

`quoteFixture=ready|loading|unavailable|amount-unavailable` injects the existing withdrawal quote request callback. The production debounce, stale-response handling, and estimate display still run. Ready quotes use illustrative fixed exchange rates. `amount-unavailable` prices the route on the screen but fails the simulation for a typed amount. `networkFixture=unavailable` makes the request landing’s node lookup fail. These controls require an active `flowFixture` and demo mode.

`balanceFixture=<tokens>` replaces the seeded wallet balance through the balance store. `desktopFixture=unresolved|unresolved-funded` injects the desktop launcher's bridge with no injected wallet and seeds discovery's unfunded record for the first pooled address. A deposit send runs the helper page's recheck and approval (`beforeApprove` with the send's submission id), then ends without a hash (`DesktopSendUnresolvedError`), and the pool skips that address afterwards. `unresolved-funded` writes a funded record for the address 5 seconds later. The funded record is a direct store write, not discovery, and the next address is chosen by the fixture; the behavior tests for both are `test/features/deposit/depositSendUnresolved.test.tsx` and `test/features/deposit/unresolvedSend.test.ts`. Demo mode clears the unresolved marker on every page load, so these plans show persistence only across in-app navigation. Both controls require an active `flowFixture` and demo mode; `desktopFixture` is latched like `flowFixture`.

`processingFixture=conversion|earned-sweep` adds pending deposits the demo scenarios lack: a USDC deposit funded half a minute ago, or an earned registration whose broadcast was spent, funded and waiting for its manual sweep. The capture replaces `features/deposit/sipaProcessingObserver.ts` with the production `createSipaProcessingObserver` over the capture's capacity stores (`capacityFixture`) and the demo portal. It reads the seeded demo deposits as deposits on the demo portal and chain, and never writes them. The scenario reseeds on every load, so a plan keeps `processingFixture` on each path it opens. These controls require an active `flowFixture` and demo mode, and they are not protocol evidence.

`capacityFixture=clears` reports an empty bucket until the user presses a capacity Check again (the pending reason's, About limits' or the funding panel's), then the full bucket, so one page can show a blocker clearing.

`originCapacity=empty|short` sets the amount the original portal (`originFixture=other`) reports: 0 or 0.5 DAI, both below the earned registration's 0.65 DAI credit; without it the original portal reports 700 DAI. The processing observer and the registration funding panel read a recorded SIPA's portal from the same capture source (`fixtures/processing-origin.ts`), so both show the original bucket.

Each faked flow runs inside a real operation (`inOperation`), so the hand-off, the bell and the panel rows are production code. The operation adapter uses the public `provingProgress.emitSigningStart(operationId)` and `emitSigningEnd(operationId, failed)` methods, then `emitStageStart` and `emitTxHashSaved` where a real flow starts proving and saves its hash. Its preparation callback runs after the cancellation boundary and before signing. Creation persists its prepared URL before calling `onLink`, then advances that row to the settled URL and synthetic funding hash. Claim returns a distinct synthetic claim hash and stores that exact hash on its claim row. Failed attempts keep separate row identities; these hashes do not identify real chain transactions.

The claim plan waits for the claim sheet to close, then opens the bell and uses the exact Received notification title. Selecting a pending row closes Notifications without navigation or dismissal; selecting a terminal row marks it read and opens transaction details by its stored claim hash. The capture-only `capturePaylinkRows()` helper reads operation-owned rows for these assertions and requires an active fixture.

## Validation boundaries

`scripts/ui-capture/test/dialog.test.mjs` checks native modal focus, nested Escape, nondismissible state and scroll ownership in Chromium. `test/dev/flowCaptureFixtures.test.ts` checks public signing payloads, prepared-link ordering, retry identities and claim hashes against the real codec and the in-memory activity store. `test/features/contacts/contactPayNote.test.ts` distinguishes early cancellation before row creation from a later service rejection that fails only its matching row. Existing behavior tests include `test/features/withdraw/withdrawToWalletModal.test.tsx`, `test/features/paylink/visitor/paylinkCashOut.test.ts`, `test/features/requests/requestLandingScreen.test.tsx`, `test/features/onboarding/onboardingPendingStep.test.tsx`, and `test/requestContactModal.test.tsx`. Their mocked collaborators test behavior, not chain completion. The request landing suite covers StrictMode replay, one resolution per exact packet/attempt, retry, unmount, fragment replacement, stale success/failure suppression, and validation before resolution.

The seeded activity/recovery scenarios supply existing settled and recovery rows. Their stored records are display fixtures; this harness does not certify their historical transaction completion. Claim/create/recover service results use the real packet codec but do not establish chain receipts. Send and withdrawal wrappers update the public stores so production notifications react to those changes. The contexts expose only the readiness values needed by named screen consumers; provider setup and route guards continue using the original modules. Type assertions in those deliberately partial context/node/detection doubles are limited to the capture directory. Unmocked contract calls still fail.

Actual transaction claims require a coordinated live environment and successful assertions/logs from `e2e/payments/send.spec.ts`, `e2e/payments/request.spec.ts`, `e2e/payments/paylink.spec.ts`, `e2e/bridge/deposit.spec.ts`, `e2e/bridge/withdraw.spec.ts`, `e2e/bridge/withdraw-swap.spec.ts`, and the relevant `e2e/onboarding/` specs. These flow plans do not provide those results. Physical iOS Safari/Android Chrome keyboard and toolbar behavior, design review, and deployed policy checks remain separate acceptance work.

`requests-small.json` uses `flowEntry=request-small`, a current-format packet requesting 0.5 DAI against the adapter’s 1 DAI fee. It captures the external-wallet fee-exceeds-request warning separately from the tag-mismatch warning in `requests-public.json`.
