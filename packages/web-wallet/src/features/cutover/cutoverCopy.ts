/**
 * The upgrade and withdrawal strings, verbatim from the Figma "Migration" page
 * (LobEQ1bmcPDw0ahexKy1iI). Live figures, such as fees, are arguments.
 */

const COUNT = ["", "once", "twice", "three times", "four times", "five times", "six times"]
const times = (n: number) => COUNT[n] ?? `${n} times`

/** Figma 350:23847 / 409:33893. */
export const chooseCopy = {
  title: "Upgrade to keep using zk.money",
  /** Figma D1 425:2252: the network has no proven checkpoint yet. */
  waitingTitle: (until: string) => `Upgrading until ${until}`,
  stamp: "About 5 min",
  waitingStamp: "Waiting for network",
  waitingNote: "Your balance is safe and will be waiting on v6.",
  balance: "Your balance",
  note: "Unclaimed paylinks have been refunded to your balance.",
  /** The link at the end of the note (Figma 489:38760). */
  seeTransactions: "See all transactions",
  pills: ["Faster deposits", "Faster withdrawals", "Higher limits"],
  upgrade: "Upgrade now",
  withdraw: "Withdraw funds instead",
  /** Above the disabled Upgrade while the check runs: first the balance, then the rest. */
  reading: "Reading your balance",
  preparing: "Preparing your upgrade",
  slow: "This can take a few minutes.",
}

/** Figma 388:30582 / 409:33997. */
export const moveFundsCopy = {
  title: "Move your funds",
  body: "Use your passkey to transfer funds to the new zk.money. About 5 min.",
  moving: "Moving",
  next: "What happens next?",
  nextEyebrow: "WHAT HAPPENS NEXT",
  /** The steps for the passkey confirmations still to give. */
  steps: (approvals: number): (readonly [string, string])[] => [
    ...(approvals > 0
      ? [
          [
            `Confirm with passkey ${times(approvals)}`,
            approvals > 1 ? "Once per transaction" : "Once, for the whole upgrade",
          ] as const,
        ]
      : []),
    ["Keep zk.money open", "About 3 min while proving completes"],
    ["Upgrade completes", "About 2 min, safe to close the app"],
  ],
  button: "Confirm with passkey",
  /** No approval is left to give. */
  start: "Upgrade now",
  /** The upgrade moves no funds: it only updates the account. */
  update: {
    title: "Update your account",
    body: "Use your passkey to update your account on the new zk.money.",
  },
}

/** The sheet over a working run (Figma 409:36603, 409:36710). */
export const workingCopy = {
  preparing: "Preparing transaction…",
  signing: "Confirm with passkey...",
  /** The run waits for the tap that opens its next passkey prompt. */
  ask: (number: number, total: number) => `Approval ${number} of ${total}`,
  usePasskey: "Use passkey",
  cancel: "Cancel",
}

/** Figma 389:31309, 409:34464, 409:34205, 423:2188. */
export const upgradingCopy = {
  title: "Upgrading...",
  /** Behind the ring's info mark (Figma 409:34205). */
  tip: "This usually takes 5 minutes, up to 10 depending on your device.",
  body: "Moving your funds to a better zk.money",
  moving: "Moving",
  steps: ["Update your account", "Withdraw from old wallet", "Deposit to new wallet"],
  updating: "Updating",
  withdrawing: "Withdrawing",
  /** An upgrade that moves no funds: its one step is the first of `steps`. */
  updateBody: "Updating your account on the new zk.money",
  keepOpen: { title: "Keep zk.money open", body: "Leaving now stops the upgrade." },
  safe: { title: "Safe to close the app", body: "We will finish in the background." },
  footer: "When this finishes it is safe to close the app.",
  sentFooter: "Reopening the app shows this screen until it is done.",
  longer: {
    title: "Taking longer than expected",
    body: "Your funds are safe and no action is needed. We keep trying.",
  },
  longerBody: "Ethereum is busy right now",
  longerRing: "Longer than usual",
  stillConfirming: (minutes: number) => `Still confirming · ${minutes} min so far`,
  notify: "Notify me when ready",
  notified: "We'll notify you",
  doneNotice: "Your upgrade is complete.",
  done: "Done",
  inProgress: (minutes: number) => `In progress · about ${minutes} min`,
  left: (minutes: number) => `About ${minutes} min left`,
  didNotComplete: "Did not complete",
}

/** Figma 389:31506 / 409:34339. */
export const leaveCopy = {
  title: "Leave upgrade?",
  body: "If you stop now, you'll need to restart the upgrade later. Don't worry, your balance is secure.",
  /** Every proof is done, so a leave pauses the run. */
  sendingBody: "Your upgrade will pause. Your funds are safe. Open zk.money again to finish it.",
  stay: "Stay and finish",
  stop: "Stop upgrade",
}

/** Figma 389:31770 / 409:35096. */
export const upgradeDoneCopy = {
  title: "Upgrade complete",
  body: (balance: string) =>
    `You can now use your balance of ${balance} again for private payments.`,
  updated: "Your account is up to date.",
  unlocked: "NOW UNLOCKED",
  newFeatures: "New features",
  button: "Go to wallet",
}

/** Figma 401:1947 / 409:38283. */
export const stoppedCopy = {
  title: "Your upgrade didn't finish",
  body: "You left before it was ready. Your balance is safe. Start again to upgrade.",
  balance: "Your balance, unchanged",
  facts: ["Nothing left your wallet", "Same balance, same tag"],
  again: "Start again",
  withdraw: "Withdraw funds instead",
}

/** Figma 401:2054 / 425:2030. Funds may have moved only in part, so they "started moving". */
export const finishCopy = {
  title: "Finish your upgrade",
  body: "Your funds started moving but the last step did not complete. They are safe. Resume to finish.",
  banner: {
    title: "The last step did not complete",
    body: "Nothing is lost. Resume and we pick up where it stopped.",
  },
  started: "Started",
  resume: "Resume",
}

/** Figma 409:37782 / 442:1105. */
export const errorCopy = {
  title: "Something went wrong",
  body: "The upgrade did not complete. Nothing moved and your balance is safe.",
  what: "What happened",
  reference: "Reference",
  retry: "Retry",
  support: "Contact support",
}

/** Figma W2 394:2165 / 426:1941, and E3 398:2009 / 426:2135 when the fee is more than the balance. */
export const withdrawChoiceCopy = {
  eyebrow: "WITHDRAW",
  title: "How should your funds leave?",
  body: "All your balance leaves zk.money: Spendable, Savings and refunded payment links.",
  lowBody: (balance: string, fee: string) =>
    `Your balance is ${balance}. The ${fee} fee would use all of it.`,
  zkMoney: {
    title: "Privately, pay with zk.money",
    body: (fee: string) => `Paste an address, and a ${fee} fee from the amount.`,
    value: (receive: string) => `You receive ${receive} · fixed fee`,
    lowBody: (fee: string) => `Not available: the ${fee} fee is more than your balance.`,
    low: (fee: string, balance: string) => `Fee ${fee} · balance ${balance}`,
    feeFailed: "Couldn't read the fee",
    /** Figma E1 400:1940: the network has no proven checkpoint yet. */
    waitingBody: (time: string) => `Opens once v6 is live, about ${time}.`,
    waiting: "Waiting for network",
  },
  wallet: {
    title: "Publicly, pay with your wallet",
    body: (fee: string) => `Your wallet pays the ${fee} fee and receives the funds, publicly.`,
    lowBody: (fee: string, balance: string) =>
      `Your wallet pays the ${fee} fee and receives the full ${balance}, publicly.`,
    value: (receive: string) => `You receive ${receive} · fee may change`,
  },
  why: "zk.money sends the transaction, so nothing on Ethereum ties the address to you. Your wallet signs its own, so it shows in that wallet's history.",
  free: "Upgrade to new version is free",
  continue: "Continue",
  upgrade: "Upgrade now instead",
}

/** Figma W3 392:2145 / 424:1964. */
export const destinationCopy = {
  title: "Withdraw",
  subtitle: "Funds from zk.money",
  label: "Paste an Ethereum address you control",
  valid: "Valid Ethereum address",
  validBody: "Ethereum mainnet only. This withdrawal cannot be reversed.",
  invalid: "That isn't a valid Ethereum address",
  check: "I checked this address. Funds sent to a wrong address cannot be recovered.",
  continue: "Continue",
}

/** Figma W4 392:2317 / 424:2108, F1 Review 392:3064 / 424:3137, E2 400:1998 / 425:2352. */
export const reviewCopy = {
  title: "Review your withdrawal",
  walletBody: (wallet: string) =>
    `Gas is paid in ETH from ${wallet}. Nothing is taken from the amount.`,
  lowBody: "Your balance is smaller than the network fee. Upgrading is free and keeps it.",
  to: "Funds go to",
  otherWallet: "Use another wallet",
  withdrawing: "Withdrawing",
  spendable: "Spendable",
  savings: "Savings",
  fee: "Network fee",
  feeNote: "ETH from your wallet, may change",
  receive: "You receive",
  next: "What happens next?",
  nextEyebrow: "WHAT HAPPENS NEXT",
  zkMoneySteps: [
    ["Confirm with passkey", "Once, for the whole withdrawal"],
    ["Keep zk.money open", "About 3 min while proving completes"],
    ["Funds arrive on Ethereum", "About 2 min. Safe to close the app"],
  ] as const,
  walletSteps: (wallet: string) =>
    [
      ["Confirm with passkey", "Once, for the whole withdrawal"],
      ["Keep zk.money open", "About 3 min while proving completes"],
      [`Approve in ${wallet}`, "Then about 2 min on Ethereum"],
    ] as const,
  lowBanner: {
    title: "The fee is more than your balance",
    body: (fee: string, balance: string) =>
      `You pay ${fee} in ETH to receive ${balance}. Upgrading moves it for free.`,
  },
  button: "Confirm with passkey",
  retry: "Try again",
  upgradeInstead: "Upgrade for free instead",
  withdrawAnyway: (balance: string) => `Withdraw ${balance}`,
}

/** Figma W6 392:2569, W7 392:2757, F1 Approve 392:3204. */
export const withdrawingCopy = {
  title: "Withdrawing...",
  body: "Sending your funds to Ethereum",
  onItsWay: (to: string) => `On its way to ${to}`,
  approveBody: (wallet: string) => `Approve the transfer in ${wallet}`,
  withdrawing: "Withdrawing",
  proof: "Proof built on this device",
  sendTo: (to: string) => `Send to ${to}`,
  approveIn: (wallet: string) => `Approve in ${wallet}`,
  confirmed: "Confirmed on Ethereum",
  keepOpen: { title: "Keep zk.money open", body: "Leaving now stops the withdrawal." },
  waiting: {
    title: "Waiting for you",
    body: (wallet: string) => `Open ${wallet} and approve the transfer.`,
  },
  waitingYou: "Waiting for you",
  approveFooter: "You can close zk.money once the transfer is confirmed.",
  browser: "your browser",
  sentSoFar: (amount: string) => `${amount} sent so far.`,
}

/** Figma W8 409:37205 / 424:2891 and F1 Done 392:3292 / 424:3380. */
export const withdrawDoneCopy = {
  title: "Withdrawal complete",
  body: (amount: string, where: string, tag?: string) =>
    `${amount} is in ${where}.${tag ? ` Your tag ${tag} is kept.` : ""}`,
  left: (amount: string) => `${amount} can't be withdrawn yet. Come back later to withdraw it.`,
  view: "View transaction",
  viewEach: (n: number) => `View transaction ${n}`,
  back: "Back to zk.money",
  notice: "Your withdrawal is complete.",
}

/** The transactions sheet the Choose page opens (Figma 489:38896). */
export const transactionsCopy = {
  title: "Your transactions",
  body: "Everything on your balance before the upgrade.",
  empty: "No transactions yet.",
}
