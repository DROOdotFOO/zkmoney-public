import { EventEmitter } from "eventemitter3"

export interface GlobalEvents {
  /**
   * Fired once it is detected that a paylink has been claimed.
   */
  paylinkClaimed: (detail: { txHash: string }) => void
}

class GlobalEventEmitter extends EventEmitter<GlobalEvents> {
  private static instance: GlobalEventEmitter

  constructor() {
    super()
  }

  public static getInstance(): GlobalEventEmitter {
    if (!GlobalEventEmitter.instance) {
      GlobalEventEmitter.instance = new GlobalEventEmitter()
    }
    return GlobalEventEmitter.instance
  }

  public emitPaylinkClaimed(detail: { txHash: string }): void {
    this.emit("paylinkClaimed", detail)
  }

  public onPaylinkClaimed(listener: (detail: { txHash: string }) => void): void {
    this.on("paylinkClaimed", listener)
  }

  public offPaylinkClaimed(listener: (detail: { txHash: string }) => void): void {
    this.off("paylinkClaimed", listener)
  }

  public cleanup(): void {
    this.removeAllListeners()
  }
}

export const globalEventEmitter = GlobalEventEmitter.getInstance()
