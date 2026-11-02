export default {
  stage: {
    sweep: {
      signing: "Approve the sweep in your wallet",
      browser: "Approve the sweep in your browser",
    },
    recover: {
      signing: "Approve the recovery in your wallet",
      browser: "Approve the recovery in your browser",
    },
    confirming: "Waiting for Ethereum confirmation",
  },
  waited: {
    minutes: "{minutes}m",
    hours: "{hours}h {minutes}m",
  },
  stuck:
    "This deposit still looks sweepable, so a relayer may yet land it in your balance. Recovering races that sweep. If the sweep wins, the recovery stops before signing and nothing is lost.",
  sweepSummary: "No relayer has picked this deposit up.",
  sweepYourself: "{summary} You can sweep it yourself. {privacy}",
  selfSweepPrivacy:
    "Sweeping it yourself is less private: it publicly links your Ethereum wallet to this deposit.",
  sweepGas:
    "You pay its Ethereum network fee in ETH; your wallet shows the amount before you approve.",
  sweepShared:
    "It draws on the same shared network capacity as any other deposit, so it can't go through while capacity is insufficient. If a relayer sweeps first, your transaction fails and the deposit is unaffected.",
  sweepDetail:
    '"Sweep now" sends it on from your Ethereum wallet, the same transaction a relayer would send: the funds continue into your private balance and the deposit fee comes back to your wallet as the network tip. {shared}',
  registrationSweepDetail:
    '"Sweep now" sends it on from your Ethereum wallet: it registers your name, what is left after the fee continues into your private balance, and the network tip comes back to your wallet. {shared}',
  recoverSecondary: "Or send the funds back out to an Ethereum address instead.",
  stranded:
    "Recovery sends this token, and any deposit token still at the address, out to an Ethereum address. It requires ETH for gas.",
  unsweepableRecover:
    "Recovery sends the funds back out to an Ethereum address. It requires ETH for gas.",
  registrationQuote:
    "This address uses the old registration price. Recover this deposit to your connected Ethereum wallet, then request a new address at the earned price. Recovery requires ETH for gas. Your zk.money wallet stays open.",
  paid: {
    tip: "Network tip to",
    recovered: "Recovered to",
  },
  heldExits: {
    both: '"Sweep now" and "Recover to an Ethereum address" are',
    sweep: '"Sweep now" is',
    recover: '"Recover" is',
  },
  needsConnect: "{exits} off until you connect an Ethereum wallet.",
  needsSwitch: "{exits} off until you switch your wallet to {chain}.",
  errors: {
    alreadySwept: "Deposit already swept",
    sweep: "Sweep failed",
    recovery: "Recovery failed",
  },
  title: {
    onItsWay: "Deposit on its way",
    recovered: "Deposit recovered",
    tooLong: "Deposit taking too long",
    recoverToken: "Recover {symbol}",
    recover: "Recover deposit",
  },
  label: "Deposit recovery",
  close: "Close",
  howSweepWorks: 'How "Sweep now" works',
  address: {
    label: "Ethereum address",
    placeholder: "0x…",
    invalid: "That isn't a valid Ethereum address",
    tipNote:
      "This address receives the network tip, and the funds themselves if you recover instead. Anyone can submit the transaction, but only this address is paid, so check it carefully.",
    fundsNote:
      "The funds will be sent to this address. Anyone can submit the transaction, but only this address receives the deposit, so check it carefully.",
  },
  connecting: "Connecting…",
  connect: "Connect wallet",
  switching: "Switching…",
  switchTo: "Switch to {chain}",
  screening: {
    checking: "Checking address…",
    blocked: "This address can't be used here. Use a different one.",
    errorAddress:
      "Couldn't verify this address. Check your internet connection or try another address.",
    errorWallet:
      "Couldn't verify this address. Check your internet connection or try another wallet.",
  },
  rows: {
    amount: "Amount",
    started: "Started",
    waiting: "Waiting",
    address: "Deposit address",
    network: "Network",
  },
  switchFirst: "Switch your wallet to {chain} first.",
  connectFirst: "Connect wallet first.",
  sweepNow: "Sweep now",
  recoverToAddress: "Recover to an Ethereum address",
  recoverTo: "Recover to {address}",
  recover: "Recover",
  preparing: "Preparing…",
  browser: {
    opened: "A page opened in your regular browser at",
    missing: ". If nothing appeared,",
    copied: "copied",
    copy: "copy link",
    openThere: "and open it there yourself.",
  },
  done: {
    registration:
      "Your name is registering, and what is left of {amount} after the fee is on its way into your private balance.",
    sweep:
      "{amount} is on its way into your private balance. It should arrive within a few minutes.",
    recovered: "{amount} sent to {target}.",
    yourWallet: "your wallet",
    tx: "Transaction ID",
    action: "Done",
  },
} as const
