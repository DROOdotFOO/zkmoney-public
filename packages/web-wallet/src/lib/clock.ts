import { createClock } from "@obsidion/front-core"

/** Wall time for selectors: request expiry, stuck clocks, countdowns. */
export const wallClock = createClock(30_000)
