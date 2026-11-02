import { describe, expect, it, vi } from "vitest"
import { IdentifierKind } from "@xmtp/browser-sdk"
import { WebXmtpClient } from "../../../src/platform/xmtp/WebXmtpClient"

const messagingIdentity = {
  identifierKind: IdentifierKind.Ethereum,
  identifier: "0x1111111111111111111111111111111111111111",
}
const bootstrapIdentity = {
  identifierKind: IdentifierKind.Ethereum,
  identifier: "0x2222222222222222222222222222222222222222",
}

function fixture(cached: typeof messagingIdentity[], current: typeof messagingIdentity[]) {
  const preferences = {
    getInboxStates: vi.fn(async () => [{ accountIdentifiers: cached }]),
    fetchInboxStates: vi.fn(async () => [{ accountIdentifiers: current }]),
  }
  const client: WebXmtpClient = Object.assign(Object.create(WebXmtpClient.prototype), {
    client: { preferences },
  })
  const peer = {
    native: { peerInboxId: async () => "peer-inbox" },
  } as unknown as Parameters<WebXmtpClient["getDmPeerAddresses"]>[0]
  return { client, peer, preferences }
}

describe("WebXmtpClient.getDmPeerAddresses", () => {
  it("includes the bootstrap identity linked after the peer inbox was cached", async () => {
    const { client, peer, preferences } = fixture(
      [messagingIdentity],
      [messagingIdentity, bootstrapIdentity],
    )

    expect(await client.getDmPeerAddresses(peer)).toEqual([
      messagingIdentity.identifier,
      bootstrapIdentity.identifier,
    ])
    expect(preferences.fetchInboxStates).toHaveBeenCalledWith(["peer-inbox"])
    expect(preferences.getInboxStates).not.toHaveBeenCalled()
  })

  it("excludes an identity revoked after the peer inbox was cached", async () => {
    const { client, peer } = fixture(
      [messagingIdentity, bootstrapIdentity],
      [messagingIdentity],
    )

    expect(await client.getDmPeerAddresses(peer)).toEqual([messagingIdentity.identifier])
  })

  it("returns no identities when refreshing fails without falling back to the cache", async () => {
    const { client, peer, preferences } = fixture([messagingIdentity, bootstrapIdentity], [])
    preferences.fetchInboxStates.mockRejectedValue(new Error("network unavailable"))

    expect(await client.getDmPeerAddresses(peer)).toEqual([])
    expect(preferences.fetchInboxStates).toHaveBeenCalledTimes(1)
    expect(preferences.getInboxStates).not.toHaveBeenCalled()
  })
})
