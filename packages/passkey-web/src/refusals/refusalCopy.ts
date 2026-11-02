import type { PasskeyHint } from "../ceremony/passkeyCeremony.js"
import type { LocalManager } from "../rules/laptopCreation.js"
import { type PhoneReach, MAC_FIREFOX_FLOOR, MAC_SAFARI_FLOOR } from "../browser/passkeyCapabilities.js"
import {
  type UserAgentInfo,
  IOS_PASSKEY_FLOOR,
  macosSyncedCopyReadsRight,
} from "../browser/userAgentInfo.js"

export const UNSUPPORTED_BROWSER_MESSAGE =
  "This browser doesn't support passkeys, or the browser features the wallet needs with them. " +
  "Use a recent version of Chrome, Safari, Edge or Firefox to create your account."

/**
 * The words a screen shows for a refusal, the phone steps, and the iOS floor notice. Data only:
 * each consumer renders it with its own components, so both web fronts say the same thing.
 */

/**
 * A refusal's title and whether another attempt can help; `message` replaces the error's own body.
 * `openInBrowser` marks a row whose way out is the phone's own browser.
 */
export type RefusalRow = { title: string; retry: boolean; message?: string; openInBrowser?: true }

/** One row per policy error, keyed by the error's stable name. */
export const REFUSAL_ROWS: Readonly<Record<string, RefusalRow>> = {
  // Named for both routes: a refusal is raised after the ceremony, where the browser's answer
  // about reaching a phone is no longer at hand, and both routes are open on every laptop.
  RelatedOriginPasskeyError: { title: "Passkeys unavailable on this site", retry: false },
  PhoneRequiredError: { title: "Use your phone or a security key", retry: true },
  LocalPasskeyRequiredError: { title: "Use this phone or a security key", retry: true },
  SecurityKeyRequiredError: { title: "Keep using the same security key", retry: true },
  DeviceBoundPasskeyError: { title: "This passkey can't be backed up", retry: true },
  IncompleteCreationError: { title: "This browser couldn't finish", retry: true },
  NoPrfError: { title: "Try a different passkey manager", retry: true },
  SecurityKeyNoPrfError: { title: "This device can't use that security key", retry: true },
  SingleSaltProviderError: { title: "Try a different passkey manager", retry: true },
  UnsupportedProviderError: { title: "That passkey provider isn't supported", retry: true },
  LaptopPasskeyRefusedError: { title: "Save the passkey somewhere else", retry: true },
  PhoneUnreachableError: { title: "Update this browser, or use Chrome", retry: false },
  NoWalletForPasskeyError: { title: "No wallet for this passkey", retry: true },
  RotatedCredentialError: { title: "This passkey's key changed", retry: false },
  AmbiguousPasskeyError: { title: "Contact support", retry: false },
}

export const REFUSAL_FALLBACK: RefusalRow = { title: "Couldn't use this passkey", retry: true }

/** An iOS app's built-in browser rejected the passkey the way a closed sheet does. */
export const IN_APP_BROWSER_REFUSAL = "InAppBrowser"

const IN_APP_ROW: RefusalRow = {
  title: "This browser couldn't use a passkey",
  retry: true,
  openInBrowser: true,
  message: "If you opened this link inside another app, open it in your phone's browser instead.",
}

/**
 * A browser that cannot run a passkey, most often an app's built-in one. Apart from
 * `REFUSAL_ROWS` because neither is a policy error. The iOS in-app row offers no retry: that
 * browser has never answered a passkey request.
 */
export const IN_APP_BROWSER_ROWS: Readonly<Record<string, RefusalRow>> = {
  NotSupportedError: IN_APP_ROW,
  [IN_APP_BROWSER_REFUSAL]: { ...IN_APP_ROW, retry: false },
}

/**
 * The line under a refusal whose error says a passkey was written (`passkeyWritten`). Each front
 * builds the href from its passkeys docs URL and `anchor`.
 */
export const LEFTOVER_PASSKEY_COPY = {
  line: "A passkey may have been saved.",
  link: "How to delete it",
  anchor: "leftover-passkey",
} as const

/**
 * The link under an Apple Passwords refusal (`appleRefusedHere`), to the docs entry on where Apple
 * Passwords works. Each front builds the href from its passkeys docs URL and `anchor`.
 */
export const APPLE_FLOOR_COPY = {
  link: "Why Apple Passwords didn't work here",
  anchor: "save-somewhere-else",
} as const

/**
 * The words around an Open in browser link. `hint` follows the link and `hintAlone` stands where
 * no link is shown. In X's app, which drops the link, `xMenu` follows another action, `xMenuAlone`
 * leads, and `xCopy` offers Copy link after it.
 */
export const OPEN_IN_BROWSER_COPY = {
  open: "Open in browser",
  hint: "Or tap ⋯ in this app and choose Open in browser.",
  hintAlone: "Tap ⋯ in this app and choose Open in browser.",
  xMenu: "Or tap ⋮ next to the web address at the bottom, then Open in browser.",
  xMenuAlone: "Tap ⋮ next to the web address at the bottom, then Open in browser.",
  xCopy: "Or copy the link and open it in your browser.",
  copyLink: "Copy link",
  copied: "Copied",
  copiedStatus: "Link copied.",
  copyFailed: "Couldn't copy. Press and hold the address above to select and copy it.",
} as const

/**
 * The card shown in an app's built-in browser before any passkey request. The title names the
 * problem and the way-out block under it names the step, which differs by what the address can
 * carry.
 */
export const IN_APP_UP_FRONT_COPY = {
  title: "Passkeys don't work in this app's browser",
  line: "zk.money uses a passkey to create and open your account.",
} as const

/**
 * The line the in-app card adds for a phone's Chrome below the floor whose brands say nothing, so
 * the page cannot tell a web view from Chrome: it suggests an update. In parts, so a front can link
 * the store.
 */
export const UPDATE_CHROME_COPY = {
  maybeBefore: "If you're already in Chrome, update it from the ",
  maybeLink: "Play Store",
  maybeAfter: " and open this page again, or use another browser.",
} as const

/** What a screen keeps of a refusal: the error's stable name and its own words. */
export type RefusalState = { name: string; message: string }

/** The row for an error; a consumer's `extraRows` add rows for its own errors or replace shared ones. */
export function refusalFor(
  error: { name: string },
  extraRows?: Readonly<Record<string, RefusalRow>>,
): RefusalRow {
  return extraRows?.[error.name] ?? REFUSAL_ROWS[error.name] ?? REFUSAL_FALLBACK
}

/** The device to fetch, drawn above the steps, and the line that says so for readers who skim. */
export type StepsHero = { glyph: "phone" | "security-key"; title: string }

/**
 * One control on the sign-up sheet: which authenticator the user says will answer, and the hint
 * that steers the browser towards it. The first route is the variant's button and opens the
 * browser's prompt on the device its hint names; the routes after it are the links under the
 * button, each opening another variant whose own button opens the prompt.
 */
export type StepsRoute = { hint: PasskeyHint; label: string }

const USE_SECURITY_KEY = "Use a security key"
const USE_PHONE = "Use my phone"

/**
 * The two things a laptop user does next, shown before every ceremony. The passkey may live on a
 * phone or on a security key and the screens cannot tell which, so the steps name both routes
 * rather than send half the users after the wrong one. The variants named below are the campaign
 * sheet's; the wallet's laptop sign-up sheet is `SIGN_UP_SHEET_COPY`.
 */
export const PHONE_STEPS_COPY = {
  hero: { glyph: "phone", title: "Have your phone or security key ready" } as StepsHero,
  /**
   * Shown where the routes are offered, which is only a creation: it asks for a cross-device
   * authenticator outright, so the prompt opens on the route the user picks.
   */
  createSteps: [
    "Your new passkey will be saved on your phone or a security key.",
    "Choose one below, then follow your browser's prompts.",
  ],
  continueLabel: "Continue",
  /** The laptop sign-up sheet: what to do with the browser's QR code. */
  title: "Scan QR code to create the passkey on your phone",
  /**
   * Under a variant's button, beside the docs link: a label whose tooltip lists the managers and
   * key a creation admits. A refused manager is named by its refusal, so the tooltip names none.
   */
  supported: {
    label: "Supported passkeys",
    title: "Works with",
    providers: [
      "iCloud Keychain",
      "Google Password Manager",
      "1Password",
      "YubiKey 5, Trezor or Ledger security key",
    ],
    refused: "Other password managers aren't supported yet.",
  },
  /** A link to the passkeys docs page; each front supplies the URL. */
  docsLink: "How passkeys work on zk.money",
  /**
   * One sentence on the key variant where a password manager's extension answers passkeys, and on
   * the campaign's help card. The phone variant says nothing: a manager's answer there is refused
   * by name. A manager on the phone is accepted, so it names this computer's. Closing a manager's
   * window can end the sign-up and managers word their way past differently, so it says what not
   * to do and leaves the rest conditional.
   */
  extension:
    "If a password manager pops up on this computer, don't save the passkey there. Choose " +
    "another device or hardware key if it offers one.",
  routes: [
    { hint: "hybrid", label: "Show QR Code" },
    { hint: "security-key", label: USE_SECURITY_KEY },
  ] as readonly StepsRoute[],
  cancelLabel: "Cancel",
  /**
   * The key variant: shown where the browser reports no route to a phone, and where the user picks
   * the key on the phone variant.
   */
  noPhone: {
    hero: { glyph: "security-key", title: "Have your security key ready" } as StepsHero,
    createSteps: [
      "Plug in the security key that will hold your new passkey.",
      "Tap below, then follow your browser's prompts.",
    ],
    title: "Create account with your security key",
    /** Heads the collapsed note and models lines. */
    detailsLabel: "About security keys",
    note:
      "Your security key keeps the only copy of your passkey. A second key can't be added as a " +
      "backup, and there is no account recovery: lose the key, lose the wallet.",
    /** The key families the wallet admits; not every model of each is measured. */
    models: "YubiKey 5 series, Trezor and Ledger keys are supported today",
    /** Back to the phone variant; offered only where a phone route exists. */
    back: USE_PHONE,
    routes: [{ hint: "security-key", label: "Use security key" }] as readonly StepsRoute[],
    caption:
      "This computer can't reach a phone, so a security key is the only passkey it can use, and a " +
      "key keeps the only copy of what it holds. If a phone holds your passkey, open zk.money on a " +
      "computer that can reach it.",
  },
  /** The laptop sign-up sheet's lines; `signUpOptionsFor` picks among them. */
  local: {
    title: "Create your passkey",
    /** Under Continue, to the help page's list of the passkeys that work. */
    docs: { label: "Supported passkeys and how they work", anchor: "which-passkeys-work" },
    /** A Mac row with 1Password alone, where the Mac's passkey window offers it. */
    pickOnePassword: "When your browser asks where to save the passkey, pick 1Password.",
    /** Under it where a phone is reachable: the Mac's provider may be Apple Passwords alone. */
    noOnePasswordHere: "If the Mac doesn't offer 1Password, use your phone.",
    installExtension: "To use 1Password, install its browser extension and reload this page.",
    /** Shown when the sheet re-opens after the browser's prompt closed with nothing created. */
    unfinished: "Setup didn't finish. Try again, or use your phone.",
    /** The same, re-opening on another device, where the phone is no alternative. */
    unfinishedElsewhere: "Setup didn't finish. Try again.",
    /** The sheet re-opens after the browser refused the request before a prompt could open. */
    blocked:
      "Your browser didn't open a passkey prompt. Close any passkey window open in another tab or " +
      "browser, then try again.",
    /** The same, on the second such refusal in a row. */
    blockedAgain:
      "Your browser still didn't open a passkey prompt. Close any passkey window open in another " +
      "tab or browser, then try again, or try another browser.",
    /** Where a password manager's extension answers passkeys. */
    extension: "If a password manager pops up, dismiss it and use your browser's own prompt.",
    /** Added once a manager the row cannot use kept answering. */
    refusedOften: "Failed to save passkey. Please use one of the supported password managers.",
    /**
     * Why the sheet opened on another device: a manager this row cannot use kept answering on
     * this computer. Keyed by the option it opened on.
     */
    steered: {
      phone: "A passkey zk.money can't use keeps being saved here, so the phone comes first.",
      key: "A passkey zk.money can't use keeps being saved here, so the security key comes first.",
    },
  },
  /**
   * Where another browser on Windows or Linux keeps phone creation and Chrome would not: a line over
   * the picker, its lead set in bold.
   */
  chromeTip: {
    lead: "Chrome recommended.",
    gpm: "It can save the passkey on this computer, with no QR code.",
  },
} as const

/**
 * Under a sign-up refused for saving on this computer, where Chrome could have saved it here
 * (`chromeTip` of `gpm`).
 */
export const CHROME_REFUSAL_COPY = "Or sign up in Chrome and save it in Google Password Manager."

/**
 * Ends a laptop sign-up's refusal when Bitwarden's extension answered. Its excluded domains match
 * the exact host, so the line names the page's own.
 */
export const bitwardenLineFor = (host: string): string =>
  `To stop Bitwarden popping up here, add ${host} to Bitwarden's excluded domains, then try again.`

/** How the sheet names each manager. */
export const SUPPORTED_NAMES: Readonly<Record<LocalManager, string>> = {
  "apple": "iCloud Keychain",
  "gpm": "Google Password Manager",
  "1password": "1Password",
}

/** The "Supported passkeys" tip: its label, heading, the names listed, and what is refused. */
export type SupportedCopy = {
  label: string
  title: string
  providers: readonly string[]
  refused: string
}

/**
 * The card a laptop sign-up gets when the browser's sheet closed before a passkey came back, and the
 * panel
 * that hands the page to the phone. `quick` follows a request closed within 10 seconds, `slow` one
 * open longer; `noPhone` follows a closed security-key sheet on a computer that can't reach a phone.
 * Each answer carries the value its report sends.
 */
export const PHONE_HELP_COPY = {
  quick: {
    title: "Create your passkey with your phone",
    body: "The next prompt shows a QR code. Scan it with your phone's camera to save your passkey there.",
  },
  slow: {
    title: "Your phone didn't connect",
    body:
      "Check that Bluetooth is on for this computer and your phone, and that your phone is " +
      "online, then try again.",
  },
  noPhone: {
    title: "Sign up on your phone instead?",
    body:
      "This computer can't reach a phone, so here it can only use a security key. If you don't " +
      "have one, open zk.money on your phone and sign up there.",
    retry: "Try again with my security key",
  },
  /** The title where an extension answers passkeys: its window, not the phone, may have ended it. */
  extensionTitle: "That didn't finish",
  tryAgain: "Try again",
  phoneLink: "Sign up on your phone instead",
  securityKey: USE_SECURITY_KEY,
  link: {
    title: "Sign up on your phone",
    body: "Scan this code with your phone's camera to open zk.money there.",
    inviteKept: "Your invite is kept.",
    qrLabel: "QR code that opens this page on your phone",
  },
  question: {
    title: "What happened?",
    placeholder: "Pick one (optional)",
    answers: [
      { value: "no_phone", label: "Didn't have my phone" },
      { value: "no_bluetooth", label: "Bluetooth is off or missing" },
      { value: "windows_hello", label: "Windows asked for Windows Hello / PIN", windowsOnly: true },
      { value: "phone_failed", label: "Phone didn't connect" },
      { value: "other", label: "Something else" },
    ],
    thanks: "Thanks.",
  },
} as const

/**
 * The laptop sign-up sheet: a picker of where the new passkey lives. `signUpOptionsFor` decides
 * which options and lines show; lines the campaign's sheet shares stay in `PHONE_STEPS_COPY`.
 */
export const SIGN_UP_SHEET_COPY = {
  title: PHONE_STEPS_COPY.local.title,
  pickerLabel: "Where should your passkey live?",
  continueLabel: PHONE_STEPS_COPY.continueLabel,
  onePassword: {
    label: "1Password",
    description: "Saved by the 1Password extension in this browser",
  },
  /** Over the running button while a script zk.money cannot use answers the page's creation. */
  extensionWarning:
    "Unsupported browser extension detected! If it opens its own pop-up, close it and use the " +
    "native passkey prompt.",
  computer: {
    label: "This computer",
    macLabel: "This Mac",
    /** Followed by the managers This computer reaches, joined by "or". */
    savedIn: "Saved in",
    /** A Mac row with 1Password alone and no extension-backed 1Password option. */
    macWindow: "Saved in 1Password through your Mac's passkey window",
  },
  phone: {
    label: "Your phone",
    description: "Scan a QR code to save it on your phone",
  },
  key: {
    label: "Security key",
    description: "A YubiKey 5, Trezor or Ledger you plug in or tap",
    /** Where no phone can be reached but this computer can still save the passkey. */
    noPhone: "This computer can't reach a phone.",
  },
  /** Where the browser ignores hints, so its own prompt offers both. */
  phoneOrKey: {
    label: "Your phone or a security key",
    description: "Your browser shows a QR code for your phone, and a security-key option",
    windows:
      'In the next prompt, choose "iPhone, iPad or Android device" for your phone, or "Security ' +
      'key", not Windows Hello.',
  },
  /** One line under each option that can reach a key; its tip holds the loss note. */
  keyWarning: {
    label: PHONE_STEPS_COPY.noPhone.detailsLabel,
    note: PHONE_STEPS_COPY.noPhone.note,
    models: PHONE_STEPS_COPY.noPhone.models,
  },
} as const

/** The settings sheet's backup picker; `backupAddOptionsFor` picks among these and the sign-up's. */
export const BACKUP_ADD_SHEET_COPY = {
  pickerLabel: "Where should your backup passkey live?",
  /** The destination, not the script: on some browsers the extension hands the request back. */
  onePassword: { description: "Saved in 1Password" },
  proton: { label: "Proton Pass", description: "Saved in Proton Pass" },
  computer: { description: "Saved by your browser's own passkey prompt" },
  phone: {
    /** The managers admitted over QR; any other on the phone is refused by name. */
    managers:
      "On your phone, save it in iCloud Keychain, Google Password Manager or 1Password. Other " +
      "passkey managers can't hold a backup over QR.",
  },
  /** A key keeps the only copy of the backup; the wallet's other passkey still opens it. */
  keyWarning: {
    label: PHONE_STEPS_COPY.noPhone.detailsLabel,
    note:
      "Your security key keeps the only copy of this backup passkey. Lose the key and the backup " +
      "is gone; your other passkey still opens the wallet.",
    models: PHONE_STEPS_COPY.noPhone.models,
  },
} as const

/**
 * The laptop sign-in sheet. The browser cannot be steered to one device — its own account chooser
 * lists every passkey it can reach and honours no routing hint — so the sheet does not promise a
 * device. It names the one action and lets the browser's prompt offer whatever holds the passkey:
 * this computer's synced copy, a phone over QR, or a security key.
 */
export const SIGN_IN_SHEET_COPY = {
  title: "Sign in",
  subtitle: "Continue with the passkey you made when you signed up.",
  continueLabel: "Continue",
  cancelLabel: "Cancel",
} as const

/**
 * The card for a record mismatch, by verdict. `wrong-key` is certain — this computer's copy is
 * returning a key that is not the account's, a known Apple bug — so there is no retry: the same
 * copy would answer again, and the card sends the user to "Show passkeys" to pick another device.
 * `not-reproduced` is the weaker "this attempt didn't open it", which a re-run or another device
 * may still resolve.
 */
export const MISMATCH_COPY: Readonly<Record<"wrong-key" | "not-reproduced", RefusalRow>> = {
  "wrong-key": {
    title: "This computer is returning the wrong key",
    retry: false,
    message:
      "This computer's copy of your passkey is returning the wrong key — a known Apple bug on some " +
      "macOS versions. Your wallet is fine; choose Show passkeys and, in the browser's prompt, pick " +
      "your phone (scan the QR code with it) or a security key.",
  },
  "not-reproduced": {
    title: "That didn't open your wallet",
    retry: true,
    message:
      "That passkey didn't open your wallet this time. Try again, or open it with your phone or a " +
      "security key.",
  },
}

const MAC_UPDATE_FIXED = "later versions fixed this on the Macs we tested."

/** Under a Mac sign-in card the Apple bug may explain: an update is worth a try, never a promise. */
export const MAC_UPDATE_COPY = {
  below: `Updating macOS is worth a try: ${MAC_UPDATE_FIXED}`,
  unknown: `If this Mac isn't on the latest macOS, updating it is worth a try: ${MAC_UPDATE_FIXED}`,
} as const

export type MacUpdateAdvice = keyof typeof MAC_UPDATE_COPY

/** Which update line a Mac gets: none where the reported macOS already reads its synced copy right. */
export function macUpdateAdviceFor(ua: UserAgentInfo): MacUpdateAdvice | undefined {
  if (ua.osFamily !== "macos") return undefined
  if (!ua.osVersionFromHints) return "unknown"
  return macosSyncedCopyReadsRight(ua.osVersionReported) ? undefined : "below"
}

/** The certain wrong key on a Mac, whose card leads with the phone. */
export const MAC_WRONG_KEY_COPY: RefusalRow = {
  title: "This computer is returning the wrong key",
  retry: false,
  message:
    "This Mac's copy of your passkey is returning the wrong key, a known Apple bug on some macOS " +
    "versions. Your wallet is fine. Use your phone this time and scan the QR code with it. After " +
    "that, you stay signed in until you sign out or this browser clears its data.",
}

/**
 * A phone's one-tap step before a sign-in's second prompt. The first approval could not settle
 * which key the passkey holds, and a prompt that opens seconds after the last tap may be refused
 * by the browser, so the tap is asked for rather than assumed.
 */
export const APPROVE_AGAIN_COPY = {
  title: "One more approval",
  body: "On a new browser, your passkey has to approve twice so the wallet can be sure it has the right key. Approve once more to finish signing in.",
  continueLabel: "Continue",
  cancelLabel: "Cancel",
} as const

/** The phone variant, or the key-only one where no phone can be reached. */
type PhoneStepsCopy = typeof PHONE_STEPS_COPY | typeof PHONE_STEPS_COPY.noPhone

/**
 * The steps to show for what the browser said about reaching a phone. A front calls this rather
 * than matching on the reach itself, so the two never drift.
 */
export function stepsCopyFor(reach: PhoneReach): PhoneStepsCopy {
  return reach === "no-hybrid" ? PHONE_STEPS_COPY.noPhone : PHONE_STEPS_COPY
}

/** Shown before a ceremony, and as its refusal, where the browser claims an iOS below the floor. */
export const IOS_FLOOR_COPY =
  `zk.money needs iOS ${IOS_PASSKEY_FLOOR} or later to use passkeys. Update iOS in Settings, or ` +
  "use another device."

/** The refusal for a Mac browser below the sign-up floor. Safari updates apart from macOS. */
export const MAC_BROWSER_FLOOR_COPY =
  `Signing up on a Mac needs Safari ${MAC_SAFARI_FLOOR} or later, or Firefox ${MAC_FIREFOX_FLOOR} ` +
  "or later. Update this browser, or sign up in Chrome or on your phone. Safari updates are in " +
  "System Settings > General > Software Update."

/** Which wording the advice takes: `use` where 1Password's script answers the page's creation. */
export type ExtensionAdvice = "use" | "install"

const WINDOWS_PASSKEY_WINDOW =
  "If 1Password answered in the Windows passkey window, it can't give zk.money the key it needs " +
  "there."

/**
 * Under a refusal for want of key material on Windows, where this computer answered. 1Password's
 * Windows app, answering in the Windows passkey window, returns none; its browser extension does.
 * A refusal cannot always name what answered, so this is advice beside it, never a refusal of its
 * own.
 */
export const EXTENSION_ADVICE_COPY: Readonly<Record<ExtensionAdvice, string>> = {
  use: `${WINDOWS_PASSKEY_WINDOW} Use the 1Password browser extension's pop-up instead.`,
  install:
    `${WINDOWS_PASSKEY_WINDOW} Install or turn on the 1Password browser extension, reload this ` +
    "page, and use its pop-up.",
}
