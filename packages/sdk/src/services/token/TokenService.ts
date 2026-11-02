import { planWithdrawal, type WithdrawalOptions } from "../withdrawal/plainWithdrawal.js"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { EthAddress } from "@aztec-labs/aztec.js/addresses"
import { BlockNumber, Fr } from "@aztec-labs/aztec.js/fields"
import { type Account, NO_FROM } from "@aztec-labs/aztec.js/account"
import { type AuthWitness, computeAuthWitMessageHash } from "@aztec-labs/aztec.js/authorization"
import { decodeFromAbi, type FieldLike } from "@aztec-labs/aztec.js/abi"
import type { Contract } from "@aztec-labs/aztec.js/contracts"
import type { TxHash, TxReceipt } from "@aztec-labs/stdlib/tx"
import { formatUnits, parseUnits } from "viem"
import { type MethodOptions, ServiceContractBase } from "../ServiceBase.js"
import { isAlreadyClaimedDepositError } from "./depositReceipt.js"
import { buildTeeOperation, requireSpendMetadataResolver } from "../tee/teeOperation.js"
import { buildSponsoredTeeOperation } from "../tee/sponsoredTeeOperation.js"
import { sponsoredAccounts } from "../claimFpc/sponsoredAccounts.js"
import {
  type ClaimSponsorContext,
  authorizeSponsoredBatch,
  chainInfoFields,
  registerSponsorFpc,
} from "../claimFpc/claimSponsor.js"
import { ObsidionAccount } from "../../obsidion/alpha/account/ObsidionAccount.js"
import {
  type ContractService,
  DEFAULT_CONTRACTS,
  OxideTokenContract,
  OxideTupleUnresolvedError,
  ensureContractRegisteredInPXE,
  type Transfer as TransferEvent,
} from "@obsidion/contracts"
import { emptyTransferMeta } from "@obsidion/core/constants"
import { WalletError } from "@obsidion/core/errors"
import type { ObsidionWallet, TxHashCallback } from "../../obsidion/ObsidionWallet.js"
import { buildTransferMetaForSend, decodeTransferMeta } from "./transferMeta.js"
import type {
  DepositSpendMetadataResolver,
  Operation,
  SpendMetadataResolver,
} from "../../oxide/index.js"
import type { RegisteredTeeSigner } from "@oxide/oxide-client/types.js"
import {
  publishAndLockOxideTokenWithArtifact,
  registerOxideTokenWithArtifact,
} from "@oxide/oxide-client/token_registration.js"
import type { OxideTokenImmutables } from "@oxide/oxide-lib/token_immutables.js"
import { buildTokenOperationCall } from "../tee/tokenOperationCall.js"
import type { OxideTokenImmutablesSource } from "../../oxide/token/tokenRegistration.js"

/** What fixes a sponsored exit's intent: who burns, how much, and where the withdrawal goes. */
export interface SponsoredExitPlanOptions {
  userAccount?: ObsidionAccount
  useRawAmount?: boolean
  withdrawal: WithdrawalOptions
  /** Paid to the first prover of the burn's checkpoint, out of `amount`. */
  proverTip?: bigint
}

export type Token = {
  address: string
  name: string
  symbol: string
  decimals: number
  logo?: string
}

export type TokenTransferEventClaims = {
  sender: AztecAddress
  recipient: AztecAddress
  amount: string | number | bigint
  blockNumber: number | bigint
  txHash?: TxHash
  recipientAccount?: Account
  useRawAmount?: boolean
}

/**
 * Discriminated result of `TokenService.verifyTransferClaims`.
 *
 */
export type VerifyTransferClaimsResult =
  | {
      ok: true
      event: {
        from: AztecAddress
        to: AztecAddress
        amount: bigint
        blockNumber: number
        /** Sender-asserted `meta` fields (request id, tag, memo), when set. */
        requestId?: string
        senderTag?: string
        memo?: string
      }
    }
  | { ok: false; reason: "mismatch" | "not-yet-available" | "threw"; cause?: unknown }

/**
 * TokenService — user-facing wrapper around the vendored OxideTokenContract
 * for private balance + transfer operations. The contract owns balances + acts
 * as the L1 bridge endpoint.
 */
export class TokenService extends ServiceContractBase {
  private static immutablesSource?: OxideTokenImmutablesSource
  private static immutablesStored = new WeakMap<ObsidionWallet, Map<string, Promise<void>>>()

  /**
   * Where every token service reads its token's immutables, which the token's private functions read from the PXE.
   * Unset, a token is called without storing them.
   */
  public static setImmutablesSource(source: OxideTokenImmutablesSource | undefined): void {
    TokenService.immutablesSource = source
  }

  private tokenInfo?: Token
  private bridgeContract?: OxideTokenContract
  private relayerUrl?: string
  private relayerHeaders?: Record<string, string>
  private relayerSenderAddress?: AztecAddress

  private constructor(
    wallet: ObsidionWallet,
    public account: Account,
    teeSigner?: RegisteredTeeSigner,
  ) {
    // Single-asset by construction: the contract binding is always the
    // consolidated oxideToken — callers don't (and can't) pick a token.
    super(DEFAULT_CONTRACTS.oxideToken, wallet, undefined, undefined, undefined, teeSigner)
  }

  public static async create(
    wallet: ObsidionWallet,
    account: Account,
    contractAddress?: AztecAddress,
    teeSigner?: RegisteredTeeSigner,
    relayerUrl?: string,
    relayerHeaders?: Record<string, string>,
  ): Promise<TokenService> {
    const holderAccount = (await wallet.getAccounts()).some((acc) =>
      acc.item.equals(account.getAddress()),
    )

    if (!holderAccount) {
      throw new Error("Account not found in wallet")
    }

    const service = new TokenService(wallet, account, teeSigner)
    await service.ensureContractsRegistered()

    if (contractAddress) {
      // Another asset's token, or a retired deployment's, can be new to this PXE.
      await ensureContractRegisteredInPXE(wallet.pxe, wallet.node, contractAddress, () =>
        service.contractService.getArtifactForContract(
          DEFAULT_CONTRACTS.oxideToken,
          contractAddress,
          wallet,
        ),
      )
      service.contractAddress = contractAddress
    } else {
      // Try to resolve existing address
      try {
        const address = await service.getContractAddress()
        service.contractAddress = address
      } catch (error) {
        // A manifest outage or configuration fault, not "token not deployed" — an addressless
        // service would fail every flow generically until restart, so surface it to the caller.
        if (error instanceof OxideTupleUnresolvedError) throw error
        // Token not deployed yet — that's OK for deploy scenarios
      }
    }

    service.relayerUrl = relayerUrl
    service.relayerHeaders = relayerHeaders
    await service.ensureRelayerSenderRegistered()

    return service
  }

  // ============================================================
  // PUBLIC LIFECYCLE / SETUP
  // ============================================================

  /**
   * Register the relayer's L2 account as a PXE sender so claim notes
   * minted by `/sweep` jobs become visible to `balance_of_private`. Safe to
   * call repeatedly (e.g. on pull-to-refresh if the relayer wasn't up at
   * first TokenService.create).
   */
  public async ensureRelayerSenderRegistered(
    relayerUrl?: string,
    relayerHeaders?: Record<string, string>,
  ): Promise<void> {
    const url = relayerUrl ?? this.relayerUrl
    const headers = relayerHeaders ?? this.relayerHeaders
    if (!url) return

    try {
      const res = await fetch(`${url}/relayer-address`, headers ? { headers } : undefined)
      if (!res.ok) {
        console.warn(
          `[TokenService] relayer-address fetch failed (${res.status}); claim notes may stay invisible`,
        )
        return
      }
      const { address } = (await res.json()) as { address: string }
      if (!address) return

      const sender = AztecAddress.fromStringUnsafe(address)
      await this.wallet.registerSender(sender)
      if (!this.relayerSenderAddress?.equals(sender)) {
        console.log("[TokenService] Registered relayer as sender:", address.slice(0, 10) + "...")
      }
      this.relayerSenderAddress = sender
      this.relayerUrl = url
      this.relayerHeaders = headers
    } catch (err) {
      console.warn("[TokenService] Could not register relayer sender:", err)
    }
  }

  public get tokenAddress(): AztecAddress {
    if (!this.contractAddress) {
      throw new Error(`Token ${this.contractName} not deployed or address not set`)
    }
    return this.contractAddress
  }

  /**
   * The token address, or null before it resolves. For render-path callers: `tokenAddress`
   * throws, and optional chaining does not guard a throwing getter, so reading it during the
   * window where balances hydrate from cache ahead of deployment lookup would crash.
   */
  public get tokenAddressOrNull(): AztecAddress | null {
    return this.contractAddress ?? null
  }

  /** The token's address, name, symbol and decimals; throws before `fetchTokenInformation` reads them. */
  public get metadata(): Token {
    if (!this.tokenInfo)
      throw new WalletError("invariant", `Token ${this.contractName} metadata not read`)
    return this.tokenInfo
  }

  public async setAccount(account: Account) {
    const holderAccount = (await this.wallet.getAccounts()).some((acc) =>
      acc.item.equals(account.getAddress()),
    )

    if (!holderAccount) {
      throw new Error("Account not found in wallet")
    }

    this.account = account
  }

  private requireTokenAddress(): AztecAddress {
    if (!this.contractAddress) {
      throw new Error(`Token ${this.contractName} not deployed or address not set`)
    }
    return this.contractAddress
  }

  /** The token contract, with its immutables stored: every token function, `sync_state` included, reads them. */
  private async requireBridgeContract(): Promise<OxideTokenContract> {
    if (!this.bridgeContract) {
      const address = this.requireTokenAddress()
      const contract = await this.getContract(address)
      this.bridgeContract = contract as OxideTokenContract
    }
    await TokenService.ensureImmutablesStored(
      this.wallet,
      this.contractService,
      this.bridgeContract.address,
    )
    return this.bridgeContract
  }

  /**
   * Stores `token`'s immutables in `wallet`'s PXE, once per wallet and token. For token calls made outside a token
   * service. A failed store is not sticky.
   */
  public static async ensureImmutablesStored(
    wallet: ObsidionWallet,
    contractService: ContractService,
    token: AztecAddress,
  ): Promise<void> {
    const source = TokenService.immutablesSource
    if (!source) return
    const byToken = TokenService.immutablesStored.get(wallet) ?? new Map<string, Promise<void>>()
    TokenService.immutablesStored.set(wallet, byToken)
    const key = token.toString()
    let stored = byToken.get(key)
    if (!stored) {
      const pending = (async () => {
        const artifact = await contractService.getArtifactForContract(
          DEFAULT_CONTRACTS.oxideToken,
          token,
          wallet,
        )
        await registerOxideTokenWithArtifact(wallet, artifact, await source(token), token)
      })()
      byToken.set(key, pending)
      pending.catch(() => {
        if (byToken.get(key) === pending) byToken.delete(key)
      })
      stored = pending
    }
    await stored
  }

  /** The token contract, with its immutables stored so its private functions can run. */
  public async getTokenContract(): Promise<Contract> {
    return (await this.requireBridgeContract()) as unknown as Contract
  }

  /**
   * Record a swept SIPA deposit into THIS PXE as a `Deposit`. The
   * utility `store_deposit` verifies the deposit's L1→L2 message
   * against the synced settled root and writes a capsule hint under
   * `recipient`'s scope — no tx, no gas, no proving; the recipient's next
   * transfer/withdraw consumes it on-chain. It must run in the recipient's
   * PXE and fails until the message settles. The claim inputs (`inboxIndex`,
   * net `amount`) come from the portal's `Deposit` event for the sweep;
   * the contract reads its own portal binding, and re-storing an
   * already-claimed index is rejected by the contract's inbox-index dedup.
   */
  public async claimSweptDeposit(params: {
    inboxIndex: bigint
    amount: bigint
    recipient: AztecAddress
    sharedSecretSalt: Fr
  }): Promise<void> {
    const tokenContract = await this.requireBridgeContract()
    await tokenContract
      .withWallet(this.wallet)
      .methods.store_deposit(
        new Fr(params.inboxIndex),
        params.amount,
        params.recipient,
        params.sharedSecretSalt,
      )
      .simulate({ from: params.recipient })
  }

  /** Reconcile a chain-verified deposit after restart, including one already spent by this account. */
  public async ensureSweptDeposit(
    params: Parameters<TokenService["claimSweptDeposit"]>[0],
  ): Promise<void> {
    try {
      await this.claimSweptDeposit(params)
    } catch (error) {
      if (!isAlreadyClaimedDepositError(error)) throw error
    }
  }

  /**
   * Metadata for deposits the batch may spend: the
   * caller's explicit resolver, else one derived from the user's
   * ObsidionAccount. Undefined for fixture accounts — a batch that then
   * consumes a claim fails with `buildTeeOperation`'s explicit error.
   */
  private async resolveDepositSpendMetadataFor(
    userAccount: Account,
    options?: { resolveDepositSpendMetadata?: DepositSpendMetadataResolver },
  ): Promise<DepositSpendMetadataResolver | undefined> {
    if (options?.resolveDepositSpendMetadata) return options.resolveDepositSpendMetadata
    if (userAccount instanceof ObsidionAccount)
      return userAccount.makeDepositSpendMetadataResolver()
    return undefined
  }

  // ============================================================
  // PUBLIC QUERY OPERATIONS
  // ============================================================

  public async getBalance(userAccount: Account = this.account): Promise<bigint> {
    try {
      const bridgeContract = await this.requireBridgeContract()
      const simulationResult = await bridgeContract.methods
        .balance_of(userAccount.getAddress())
        .simulate({
          from: userAccount.getAddress(),
        })
      return BigInt(simulationResult.result.toString())
    } catch (error) {
      throw new Error(`Failed to get private balance for ${this.requireTokenAddress()}: ${error}`)
    }
  }

  /**
   * `balance_of` at the PXE's current anchor, with no sync. For the chain-sync tick, which has
   * just synced to read events and wants the balance at that same anchor.
   */
  public async readBalanceAssumingSynced(userAccount: Account = this.account): Promise<bigint> {
    const from = userAccount.getAddress()
    const contract = await this.requireBridgeContract()
    const call = await contract.methods.balance_of(from).getFunctionCall()
    const { result } = await this.wallet.executeUtilityAssumingSynced(call, { scopes: [from] })
    return BigInt(decodeFromAbi(call.returnType, result) as bigint)
  }

  /** The token's address, and its name, symbol and decimals from its immutables. */
  public async fetchTokenInformation(): Promise<Token> {
    if (this.tokenInfo) return this.tokenInfo
    const address = this.requireTokenAddress()
    const source = TokenService.immutablesSource
    if (!source) throw new Error(`No immutables source to read the metadata of token ${address}`)
    const { name, symbol, decimals } = await source(address)
    this.tokenInfo = { address: address.toString(), name, symbol, decimals }
    return this.tokenInfo
  }

  // ============================================================
  // PUBLIC WRITE OPERATIONS
  // ============================================================

  public async sendToken(
    recipient: AztecAddress,
    amount: string,
    options?: MethodOptions<{
      userAccount?: Account
      useRawAmount?: boolean
      /**
       * Resolves spend metadata for each nullified note the TEE will sign
       * over. Production callers obtain this via
       * `ObsidionAccountContractManager.makeSpendMetadataResolver()`. Test
       * fixtures bind it directly to `buildSpendMetadata` from
       * `@oxide/oxide-client` for Schnorr-fixture accounts. Required because
       * `transfer` always nullifies spending notes.
       */
      resolveSpendMetadata?: SpendMetadataResolver
      /** Metadata for deposits this batch may spend; defaults from the ObsidionAccount. */
      resolveDepositSpendMetadata?: DepositSpendMetadataResolver
      /** Payment request this send fulfills; rides the `Transfer` event meta as its reference entry. */
      requestId?: string
      /** Sender's bare tag, carried in `meta` for recipient-side attribution. */
      senderTag?: string
      /** Recipient's bare tag, carried in `meta` so the sender's own history scan can re-adopt the contact. */
      recipientTag?: string
      /** Free-text memo, ≤ `TRANSFER_MEMO_MAX_BYTES` UTF-8 bytes. */
      memo?: string
    }>,
  ) {
    this.assertPositiveAmount(amount, "Send")
    this.emitInit()

    const userAccount = options?.userAccount ?? this.account
    const useRawAmount = options?.useRawAmount ?? false

    const rawAmount = useRawAmount ? BigInt(amount) : await this.parseAmount(amount)

    // Merge caller-supplied operationId onto sendOptions. With the U4 dispatch
    // path (`buildTeeOperation` + `sendAndWait`), the final `BatchCall.send`
    // routes back through `wallet.sendTx`, so op-id minting / withProvingScope
    // / persistPendingRecord fire as expected.
    const sendOptionsBase = await this.getSendOptions(userAccount.getAddress(), options)
    const sendOptions =
      options?.operationId !== undefined
        ? { ...sendOptionsBase, operationId: options.operationId }
        : sendOptionsBase

    const humanReadableAmount = await this.formatAmount(rawAmount)

    const resolveSpendMetadata = requireSpendMetadataResolver(
      options ?? {},
      "TokenService.sendToken",
    )
    const resolveDepositSpendMetadata = await this.resolveDepositSpendMetadataFor(
      userAccount,
      options,
    )

    // Reuse the already-resolved fee payment method from `sendOptionsBase` —
    // `getSendOptions` returned either the caller's `sendOptions` or the wallet
    // default. Calling `resolveFeePaymentMethod` again here would invoke
    // `wallet.getDefaultSendOptions` a second time. The non-paylink TokenService
    // paths have no `submitContext` and therefore don't need the 3-step chain.
    const paymentMethod = sendOptions.fee?.paymentMethod

    return this.sendAndWait(
      async () => {
        // The consolidated bridge owns balances directly, so private transfer
        // routes through `transfer(from, to, amount, authwit_nonce)`. The
        // TEE-attested DA capsules built by `buildTeeOperation` accompany the
        // tx — without them, `validate_note` fails on PXE discovery and the
        // recipient's note is silently dropped.
        const tokenContract = await this.getTokenContract()
        const { batchCall, sendOpts } = await buildTeeOperation(
          {
            wallet: this.wallet,
            node: this.wallet.node,
            paymentMethod,
            // Benchmark correlation (U3) — inert unless the flag + a caller
            // operationId are both set. Flow tag = the kind send-option.
            operationId: options?.operationId,
            benchmarkFlow: options?.kind,
          },
          userAccount.getAddress(),
          {
            tokenContract,
            signer: this.getTeeSigner(),
            operations: [
              {
                kind: "transfer",
                from: userAccount.getAddress(),
                to: recipient,
                amount: rawAmount,
                meta: buildTransferMetaForSend(options ?? {}),
              },
            ],
            buildOperationCall: (op, capsules) =>
              buildTokenOperationCall(tokenContract, op, capsules),
            resolveSpendMetadata,
            resolveDepositSpendMetadata,
            additionalScopes: undefined,
          },
        )
        return {
          interaction: batchCall,
          sendOpts,
          amount: rawAmount,
          humanReadableAmount,
          recipient,
        }
      },
      ({
        txHash,
        receipt,
        amount,
        humanReadableAmount,
        recipient,
      }: {
        txHash: string
        receipt: TxReceipt
        amount: bigint
        humanReadableAmount: string
        recipient: AztecAddress
      }) => {
        return {
          txHash,
          receipt,
          amount,
          humanReadableAmount,
          recipient: recipient.toString(),
        }
      },
      {
        sendOptions,
        profile: options?.profile,
        operationId: options?.operationId,
        kind: options?.kind,
        // Lazy-start: the sendAndWait third-arg options bag is
        // cherry-picked (not the full `options`), so `confirmGate`
        // and `silent` must be listed explicitly or they never reach
        // wallet.sendTx / sendAndWait. `silent` keeps the speculative pre-confirm
        // leg from emitting PROVING/FAILED status; `confirmGate` blocks
        // signing/prove/submit until the user confirms.
        // All undefined for non-lazy callers (inert).
        confirmGate: options?.confirmGate,
        silent: options?.silent,
      },
    )
  }

  public async verifyTransferClaims(
    claims: TokenTransferEventClaims,
  ): Promise<VerifyTransferClaimsResult> {
    const eventBlock = BlockNumber(Number(claims.blockNumber))

    let expectedAmount: bigint
    try {
      expectedAmount = claims.useRawAmount
        ? BigInt(claims.amount)
        : await this.parseAmount(claims.amount.toString())
    } catch (cause) {
      return { ok: false, reason: "threw", cause }
    }

    try {
      const events = await this.wallet.getPrivateEvents<TransferEvent>(
        OxideTokenContract.events.Transfer,
        {
          contractAddress: this.requireTokenAddress(),
          txHash: claims.txHash,
          fromBlock: eventBlock,
          scopes: [claims.recipient],
        },
      )

      if (events.length === 0) {
        return { ok: false, reason: "not-yet-available" }
      }

      const match = events.find(
        ({ event }) =>
          this.addressesEqual(event.from, claims.sender) &&
          this.addressesEqual(event.to, claims.recipient) &&
          BigInt(event.amount) === expectedAmount,
      )

      if (!match) {
        return { ok: false, reason: "mismatch" }
      }

      return {
        ok: true,
        event: {
          from: AztecAddress.fromStringUnsafe(match.event.from.toString()),
          to: AztecAddress.fromStringUnsafe(match.event.to.toString()),
          amount: BigInt(match.event.amount),
          blockNumber: match.metadata.l2BlockNumber,
          ...decodeTransferMeta(match.event.meta),
        },
      }
    } catch (cause) {
      return { ok: false, reason: "threw", cause }
    }
  }

  /**
   * Exit tokens from L2 private balance to L1. Burns tokens on L2 and emits an
   * L2->L1 message for withdrawal on L1.
   *
   * The consolidated bridge holds the balance state directly, so there is no
   * cross-contract burn and no `authwit_nonce`. The burn settles into the
   * deployment's plain withdrawal executor, which pays `WITHDRAW_RELAYER_TIP` to
   * the relayer and the rest to `l1Recipient` (see `planWithdrawal`). The portal
   * keeps `proverTip` (default `0n`) off the top for the first prover of the burn's
   * checkpoint.
   *
   * Routed through `buildTeeOperation + sendAndWait`, so the final
   * `BatchCall.send` flows back through `wallet.sendTx` and the
   * proving-progress + persist pipeline fires.
   */
  public async exitToL1Private(
    l1Recipient: EthAddress,
    amount: string,
    options: MethodOptions<{
      withdrawal: WithdrawalOptions
      /** Paid to the first prover of the burn's checkpoint, out of `amount`. */
      proverTip?: bigint
      userAccount?: Account
      useRawAmount?: boolean
      /**
       * Resolves spend metadata for each nullified note the TEE will sign
       * over. Production callers obtain this via
       * `ObsidionAccountContractManager.makeSpendMetadataResolver()`. Test
       * fixtures bind it directly to `buildSpendMetadata` from
       * `@oxide/oxide-client` for Schnorr-fixture accounts. Required because
       * `withdraw` always nullifies spending notes.
       */
      resolveSpendMetadata?: SpendMetadataResolver
      /** Metadata for deposits this batch may spend; defaults from the ObsidionAccount. */
      resolveDepositSpendMetadata?: DepositSpendMetadataResolver
    }>,
  ) {
    await this.ensureContractsRegistered()

    const userAccount = options?.userAccount ?? this.account
    const useRawAmount = options?.useRawAmount ?? false

    const rawAmount = useRawAmount ? BigInt(amount) : await this.parseAmount(amount)

    // Merge caller-supplied operationId / kind onto sendOptions. With the U4
    // dispatch path (`buildTeeOperation` + `sendAndWait`), the final
    // `BatchCall.send` routes back through `wallet.sendTx`, so op-id minting /
    // withProvingScope / persistPendingRecord fire as
    // expected.
    const sendOptionsBase = await this.getSendOptions(userAccount.getAddress(), options)
    const sendOptions =
      options?.operationId !== undefined || options?.kind !== undefined
        ? {
            ...sendOptionsBase,
            ...(options?.operationId !== undefined ? { operationId: options.operationId } : {}),
            ...(options?.kind !== undefined ? { kind: options.kind } : {}),
          }
        : sendOptionsBase

    this.emitInit()

    const humanReadableAmount = await this.formatAmount(rawAmount)

    const resolveSpendMetadata = requireSpendMetadataResolver(
      options ?? {},
      "TokenService.exitToL1Private",
    )
    const resolveDepositSpendMetadata = await this.resolveDepositSpendMetadataFor(
      userAccount,
      options,
    )

    // See `sendToken` for the same rationale: reuse the already-resolved fee
    // payment method from `sendOptionsBase` to avoid a duplicate
    // `wallet.getDefaultSendOptions` call.
    const paymentMethod = sendOptions.fee?.paymentMethod

    return this.sendAndWait(
      async () => {
        const tokenContract = await this.getTokenContract()
        const planned = await planWithdrawal(
          this.wallet,
          this.contractService,
          tokenContract.address,
          {
            from: userAccount.getAddress(),
            recipient: l1Recipient,
            amount: rawAmount,
            proverTip: options.proverTip,
          },
          options.withdrawal,
        )
        const { batchCall, sendOpts } = await buildTeeOperation(
          {
            wallet: this.wallet,
            node: this.wallet.node,
            paymentMethod,
            // Benchmark correlation (U3) — inert unless the flag + a caller
            // operationId are both set. Flow tag = the kind send-option.
            operationId: options?.operationId,
            benchmarkFlow: options?.kind,
          },
          userAccount.getAddress(),
          {
            tokenContract,
            signer: this.getTeeSigner(),
            operations: [planned.operation],
            buildOperationCall: (op, capsules) =>
              buildTokenOperationCall(tokenContract, op, capsules),
            resolveSpendMetadata,
            resolveDepositSpendMetadata,
            additionalScopes: undefined,
            teeUnsignedInteractions: planned.broadcasts,
            plainWithdrawal: planned.plainWithdrawal,
          },
        )
        return {
          interaction: batchCall,
          sendOpts,
          amount: rawAmount,
          humanReadableAmount,
        }
      },
      ({
        txHash,
        amount,
        humanReadableAmount,
        receipt,
      }: {
        txHash: string
        amount: bigint
        humanReadableAmount: string
        receipt: TxReceipt
      }) => ({
        txHash,
        amount,
        humanReadableAmount,
        l1Recipient: l1Recipient.toString(),
        blockNumber: receipt.blockNumber,
      }),
      {
        sendOptions,
        profile: options?.profile,
        operationId: options?.operationId,
        kind: options?.kind,
        // Lazy-start: the sendAndWait third-arg options bag is
        // cherry-picked (not the full `options`), so `confirmGate`
        // and `silent` must be listed explicitly or they never reach
        // wallet.sendTx / sendAndWait. `silent` keeps the speculative pre-confirm
        // leg from emitting PROVING/FAILED status; `confirmGate` blocks
        // signing/prove/submit until the user confirms.
        // All undefined for non-lazy callers (inert).
        confirmGate: options?.confirmGate,
        silent: options?.silent,
      },
    )
  }

  /**
   * ClaimFPC-sponsored, TEE-attested transfer — the `NO_FROM`, gasless counterpart of
   * {@link sendToken} for fronts with no fee service (web). Batch shape
   * `[authorize_intents, transfer, publish_da]`: the FPC dispatches `transfer(from=user, ...)`
   * itself, so msg_sender is the FPC and the spend rides a delegated intent the user signs once.
   * The call matches the FPC's policy (the shipped `ByAny` entry matches any non-FPC private call).
   *
   * Resolves once the transfer is mined — there is no intermediate `sentTx`/`txPromise` handle as on
   * the self-paid path, because the sponsored send owns the whole simulate-attest-prove pipeline.
   */
  public async sendTokenSponsored(
    recipient: AztecAddress,
    amount: string,
    sponsor: ClaimSponsorContext,
    options?: MethodOptions<{
      userAccount?: ObsidionAccount
      useRawAmount?: boolean
      resolveSpendMetadata?: SpendMetadataResolver
      resolveDepositSpendMetadata?: DepositSpendMetadataResolver
      /** Payment request this send fulfills; rides the `Transfer` event meta as its reference entry. */
      requestId?: string
      /** Sender's bare tag, carried in `meta` for recipient-side attribution. */
      senderTag?: string
      /** Recipient's bare tag, carried in `meta` so the sender's own history scan can re-adopt the contact. */
      recipientTag?: string
      /** Free-text memo, ≤ `TRANSFER_MEMO_MAX_BYTES` UTF-8 bytes. */
      memo?: string
      onTxHash?: TxHashCallback
      /** Stops the send up to its passkey prompt. */
      signal?: AbortSignal
    }>,
  ): Promise<{
    txHash: string
    blockNumber: number
    amount: bigint
    humanReadableAmount: string
    recipient: string
  }> {
    this.assertPositiveAmount(amount, "Send")
    await this.ensureContractsRegistered()

    const userAccount = options?.userAccount ?? this.account
    if (!(userAccount instanceof ObsidionAccount)) {
      throw new Error("sendTokenSponsored requires an ObsidionAccount user")
    }
    const user = userAccount.getAddress()
    const paying = sponsoredAccounts(sponsor, user)
    const rawAmount = options?.useRawAmount ? BigInt(amount) : await this.parseAmount(amount)

    this.emitInit()
    const humanReadableAmount = await this.formatAmount(rawAmount)

    const resolveSpendMetadata =
      options?.resolveSpendMetadata ?? (await userAccount.makeSpendMetadataResolver())
    const resolveDepositSpendMetadata = await this.resolveDepositSpendMetadataFor(
      userAccount,
      options,
    )

    const tokenContract = await this.getTokenContract()
    const fpcArtifact = await registerSponsorFpc(this.wallet, sponsor)
    const { chainId, version } = await chainInfoFields(this.wallet)

    // The fresh nonce salts the authwit hash, so repeat sends of the same amount to the same
    // recipient never collide on the authwit nullifier.
    const authwitNonce = Fr.random()
    const transferOp: Operation = {
      kind: "transfer",
      from: user,
      to: recipient,
      amount: rawAmount,
      authwitNonce,
      meta: buildTransferMetaForSend(options ?? {}),
    }
    const transferInteraction = buildTokenOperationCall(tokenContract, transferOp, [])
    const intentHash = await computeAuthWitMessageHash(
      { caller: sponsor.fpcAddress, action: transferInteraction },
      { chainId, version },
    )
    options?.signal?.throwIfAborted()
    const authorized = await authorizeSponsoredBatch(
      this.wallet,
      this.contractService,
      sponsor,
      user,
      userAccount.getAuthProvider(),
      [intentHash],
      { chainId, version },
      options?.signal,
    )

    const op = await buildSponsoredTeeOperation(
      { wallet: this.wallet, node: this.wallet.node as never },
      {
        fpcAddress: sponsor.fpcAddress,
        fpcArtifact,
        railId: sponsor.railId,
        policy: sponsor.policy,
        ...paying.args,
        tokenContract,
        signer: this.getTeeSigner(),
        operations: [transferOp],
        buildOperationCall: (op, capsules) => buildTokenOperationCall(tokenContract, op, capsules),
        resolveSpendMetadata,
        resolveDepositSpendMetadata,
        // `transfer` matches by address or the `ByAny` entry — no class witness needed.
        operationClassWitnesses: [undefined],
        ...authorized,
        gate: sponsor.subscribe?.gate,
      },
    )

    const sent = await this.wallet.sendTx(op.payload, {
      from: NO_FROM,
      sendMessagesAs: user,
      additionalScopes: [...paying.scopes, ...op.sendOpts.additionalScopes],
      finalize: op.sendOpts.finalize,
      fee: op.sendOpts.fee,
      operationId: options?.operationId,
      kind: options?.kind ?? "send",
      confirmGate: options?.confirmGate,
      onTxHash: options?.onTxHash,
    })
    const receipt = (
      sent as { receipt?: { txHash?: { toString(): string }; blockNumber?: number } }
    ).receipt
    const txHash = receipt?.txHash?.toString()
    if (!txHash) throw new Error("sponsored transfer returned no tx hash")

    return {
      txHash,
      blockNumber: Number(receipt?.blockNumber ?? NaN),
      amount: rawAmount,
      humanReadableAmount,
      recipient: recipient.toString(),
    }
  }

  /**
   * ClaimFPC-sponsored, TEE-attested exit to L1 — the `NO_FROM`, gasless counterpart of
   * {@link exitToL1Private} for fronts with no fee service (web). The burn is authorized BY the
   * user via a delegated authwit (`withdraw` is `#[authorize_once]`; msg_sender is the FPC), so
   * an `authorize_intents` account call rides the batch:
   * `[authorize_intents, withdraw, escrow run?, finalization request, publish_da]`. The calls match
   * the FPC's policy (the shipped `ByAny` entry matches any non-FPC private call).
   *
   * Recovery and finalization (oxide relayer, the client's withdrawal tracker)
   * are identical to the self-paid path.
   */
  public async exitToL1PrivateSponsored(
    l1Recipient: EthAddress,
    amount: string,
    sponsor: ClaimSponsorContext,
    options: MethodOptions<{
      userAccount?: ObsidionAccount
      useRawAmount?: boolean
      resolveSpendMetadata?: SpendMetadataResolver
      resolveDepositSpendMetadata?: DepositSpendMetadataResolver
      withdrawal: WithdrawalOptions
      /** See {@link exitToL1Private}. */
      proverTip?: bigint
      onTxHash?: TxHashCallback
    }>,
  ): Promise<{
    txHash: string
    blockNumber: number
    amount: bigint
    humanReadableAmount: string
    l1Recipient: string
  }> {
    const {
      userAccount,
      user,
      rawAmount,
      tokenContract,
      fpcArtifact,
      chainInfo,
      planned,
      intentHash,
    } = await this.planSponsoredExit(l1Recipient, amount, sponsor, options, Fr.random())
    const paying = sponsoredAccounts(sponsor, user)

    this.emitInit()
    const humanReadableAmount = await this.formatAmount(rawAmount)

    const resolveSpendMetadata =
      options?.resolveSpendMetadata ?? (await userAccount.makeSpendMetadataResolver())
    const resolveDepositSpendMetadata = await this.resolveDepositSpendMetadataFor(
      userAccount,
      options,
    )

    const withdrawOp: Operation = planned.operation
    const authorized = await authorizeSponsoredBatch(
      this.wallet,
      this.contractService,
      sponsor,
      user,
      userAccount.getAuthProvider(),
      [intentHash],
      chainInfo,
    )

    const op = await buildSponsoredTeeOperation(
      {
        wallet: this.wallet,
        node: this.wallet.node as never,
        operationId: options?.operationId,
        benchmarkFlow: "withdraw",
      },
      {
        fpcAddress: sponsor.fpcAddress,
        fpcArtifact,
        railId: sponsor.railId,
        policy: sponsor.policy,
        ...paying.args,
        tokenContract,
        signer: this.getTeeSigner(),
        operations: [withdrawOp],
        buildOperationCall: (op, capsules) => buildTokenOperationCall(tokenContract, op, capsules),
        resolveSpendMetadata,
        resolveDepositSpendMetadata,
        // The withdraw call matches by address or the `ByAny` entry — no class witness needed.
        operationClassWitnesses: [undefined],
        ...authorized,
        teeUnsignedInteractions: planned.broadcasts,
        plainWithdrawal: planned.plainWithdrawal,
        gate: sponsor.subscribe?.gate,
      },
    )

    const sent = await this.wallet.sendTx(op.payload, {
      from: NO_FROM,
      sendMessagesAs: user,
      additionalScopes: [...paying.scopes, ...op.sendOpts.additionalScopes],
      finalize: op.sendOpts.finalize,
      fee: op.sendOpts.fee,
      operationId: options?.operationId,
      kind: "withdraw",
      onTxHash: options?.onTxHash,
    })
    const receipt = (
      sent as { receipt?: { txHash?: { toString(): string }; blockNumber?: number } }
    ).receipt
    const txHash = receipt?.txHash?.toString()
    if (!txHash) throw new Error("sponsored exit returned no tx hash")

    return {
      txHash,
      blockNumber: Number(receipt?.blockNumber ?? NaN),
      amount: rawAmount,
      humanReadableAmount,
      l1Recipient: l1Recipient.toString(),
    }
  }

  /**
   * A sponsored exit as its batch carries it. The FPC dispatches `withdraw(from=user, ...)`, so the
   * user authorizes {caller: FPC, action: withdraw} as an intent; the nonce salts the authwit hash
   * so exits with identical parameters never collide on the authwit nullifier.
   */
  private async planSponsoredExit(
    l1Recipient: EthAddress,
    amount: string,
    sponsor: ClaimSponsorContext,
    options: SponsoredExitPlanOptions,
    authwitNonce: Fr,
  ) {
    await this.ensureContractsRegistered()

    const userAccount = options.userAccount ?? this.account
    if (!(userAccount instanceof ObsidionAccount)) {
      throw new Error("exitToL1PrivateSponsored requires an ObsidionAccount user")
    }
    const user = userAccount.getAddress()
    const rawAmount = options.useRawAmount ? BigInt(amount) : await this.parseAmount(amount)
    const tokenContract = await this.getTokenContract()
    const fpcArtifact = await registerSponsorFpc(this.wallet, sponsor)
    const chainInfo = await chainInfoFields(this.wallet)
    const planned = await planWithdrawal(
      this.wallet,
      this.contractService,
      tokenContract.address,
      {
        from: user,
        recipient: l1Recipient,
        amount: rawAmount,
        proverTip: options.proverTip,
        authwitNonce,
      },
      options.withdrawal,
    )
    const intentHash = await computeAuthWitMessageHash(
      {
        caller: sponsor.fpcAddress,
        action: buildTokenOperationCall(tokenContract, planned.operation, []),
      },
      chainInfo,
    )
    return {
      userAccount,
      user,
      rawAmount,
      tokenContract,
      fpcArtifact,
      chainInfo,
      planned,
      intentHash,
    }
  }

  // ============================================================
  // PUBLIC DEPLOY OPERATIONS
  // ============================================================

  /**
   * Publish the counterfactual token `immutables` commit to and store its immutables in this PXE.
   * The token address is fixed by the immutables, so publishing a token that exists fails.
   */
  public async publishToken(
    immutables: OxideTokenImmutables,
    options?: { deployerAccount?: Account },
  ): Promise<OxideTokenContract> {
    await this.ensureContractsRegistered()
    const deployer = (options?.deployerAccount ?? this.account).getAddress()
    const artifact = await this.contractService.getArtifactForContract(this.contractName)
    const token = await publishAndLockOxideTokenWithArtifact(
      this.wallet,
      artifact,
      immutables,
      deployer,
    )

    this.bridgeContract = OxideTokenContract.at(token.address, artifact, this.wallet)
    this.contractAddress = token.address
    const { name, symbol, decimals } = immutables
    this.tokenInfo = { address: token.address.toString(), name, symbol, decimals }
    await this.contractService.setContractAddress(this.contractName, token.address)
    return this.bridgeContract
  }

  // ============================================================
  // PUBLIC UTILITIES
  // ============================================================

  public async parseAmount(amount: string | number): Promise<bigint> {
    const tokenInfo = await this.fetchTokenInformation()
    try {
      return parseUnits(amount.toString(), tokenInfo.decimals)
    } catch {
      throw new Error(`Invalid amount format: ${amount}`)
    }
  }

  public async formatAmount(amount: bigint | number): Promise<string> {
    const tokenInfo = await this.fetchTokenInformation()
    try {
      return formatUnits(BigInt(amount), tokenInfo.decimals)
    } catch {
      throw new Error(`Invalid amount format: ${amount}`)
    }
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private assertPositiveAmount(amount: string | number | bigint, operation: string): void {
    const numAmount = typeof amount === "bigint" ? amount : Number(amount)
    if (numAmount <= 0) {
      throw new Error(`${operation} amount must be greater than zero`)
    }
  }

  private addressesEqual(actual: unknown, expected: AztecAddress): boolean {
    const equals = (actual as { equals?: (other: AztecAddress) => boolean } | undefined)?.equals
    if (typeof equals === "function") {
      return equals.call(actual, expected)
    }

    const toString = (actual as { toString?: () => string } | undefined)?.toString
    if (typeof toString !== "function") {
      return false
    }

    return toString.call(actual).toLowerCase() === expected.toString().toLowerCase()
  }

  // ============================================================
  // PAYLINK CONSTRUCTION HELPERS — paylink-driven transfer needs a
  // contract-side redesign. The consolidated bridge's `transfer` asserts
  // `from == msg_sender`, so the authwit produced here will not satisfy
  // on-chain checks for cross-contract paylink flows. The method stays on the
  // surface for compile-time compatibility; replace with a paylink-redesign
  // path when `PaylinkService` migrates.
  // ============================================================

  /**
   * @deprecated The bridge's `transfer(from, to, amount)` requires
   * `from == msg_sender`, so this authwit will not validate when called from
   * a different contract. Retained for build compatibility with
   * `PaylinkService`; replace with a paylink-redesign path.
   */
  public async constructTransferCallAuthwit(
    amount: bigint,
    sender: AztecAddress,
    contractAddress: AztecAddress,
    meta: FieldLike[] = emptyTransferMeta(),
  ): Promise<AuthWitness> {
    const bridgeContract = await this.requireBridgeContract()

    // `meta` must be the exact fields the pulling contract passes to `transfer`; the intent hash
    // covers every argument.
    const transferCall = bridgeContract.methods.transfer(sender, contractAddress, amount, meta, 0)

    const authwit = await this.wallet.createAuthWit(sender, {
      caller: contractAddress,
      call: await transferCall.getFunctionCall(),
    })

    return authwit
  }
}

// Re-export for parity with the prior surface — callers that imported
// `DEFAULT_CONTRACTS` from this module still resolve.
export { DEFAULT_CONTRACTS }
