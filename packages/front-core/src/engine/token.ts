import type {
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
  RegisteredTeeSigner,
  TokenService,
} from "@obsidion/sdk"
import type { TeeSignerSource } from "../tee/teeSignerSource"
import { logger } from "../utils/logger"
import { resource, type Backoff, type Resource } from "./resource"
import { within } from "./runtime"

const RETRY: Backoff = { baseMs: 4_000, maxMs: 60_000 }
/** Bounds one connect: an enclave attestation fetch and the L1 binding reads, maybe through proxies. */
const TEE_CONNECT_MS = 60_000

/**
 * The TEE co-signer, connected with no account behind it: a visitor cashing a link out signs too.
 * A source change, such as a manifest roll, reconnects it; a failed connect asks the source to
 * refresh before the retry.
 */
export function teeSignerResource(source: TeeSignerSource): Resource<RegisteredTeeSigner> {
  return resource(
    "teeSigner",
    {
      from: [],
      lazy: true,
      backoff: RETRY,
      changes: (onChange) => source.subscribe?.(onChange) ?? (() => {}),
    },
    async (_, { signal }) => {
      try {
        const signer = await within(source.load(), "TEE signer connect", {
          ms: TEE_CONNECT_MS,
          signal,
        })
        if (signer) {
          logger.log("[teeSigner] connected", {
            teeRegistry: signer.teeRegistry.toString(),
            source: source.label,
          })
        }
        return signer
      } catch (error) {
        if (!signal.aborted) source.refresh?.()
        throw error
      }
    },
  )
}

export interface TokenDeps {
  wallet: Resource<ObsidionWallet>
  account: Resource<ObsidionAccount>
  /** The token's contracts resolve through it. */
  contractService: Resource<ContractService>
  teeSigner: Resource<RegisteredTeeSigner>
  create(wallet: ObsidionWallet, account: ObsidionAccount): Promise<TokenService>
}

/** The wallet token's service, with its metadata read and the current TEE signer attached. */
export function tokenResource(deps: TokenDeps): Resource<TokenService> {
  return resource(
    "token",
    { from: [deps.wallet, deps.account, deps.contractService], lazy: true, backoff: RETRY },
    async ([wallet, account], { signal, follow }) => {
      const token = await within(deps.create(wallet, account), "token", { signal })
      await within(token.fetchTokenInformation(), "token metadata", { signal })
      follow(deps.teeSigner, (signer) => token.setTeeSigner(signer))
      return token
    },
  )
}
