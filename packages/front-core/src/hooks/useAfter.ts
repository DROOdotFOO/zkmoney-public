import { useEffect, useState } from "react"
import type { After, Milestone, Milestones } from "../engine/milestones"

/** Whether `after`'s waits are over. `after` keeps its identity across renders. */
export function useAfter(milestones: Milestones, after: After): boolean {
  const reached = (Object.keys(after) as Milestone[]).every((m) => milestones.reached(m))
  const [over, setOver] = useState<Milestones>()
  useEffect(() => {
    if (reached) return
    const unmounted = new AbortController()
    void milestones.after(after, unmounted.signal).then((ended) => ended && setOver(milestones))
    return () => unmounted.abort()
  }, [milestones, after, reached])
  return reached || over === milestones
}
