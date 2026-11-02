import type { Resource, ResourceState } from "../engine/resource"
import { memoryStore } from "../engine/store"
import { useStore } from "./useStore"

const NONE = memoryStore<ResourceState<never>>({ status: "pending" }).readonly

const readyValue = <T>(state: ResourceState<T>): T | undefined =>
  state.status === "ready" ? state.value : undefined

/** A resource's value once it is ready. Reading never demands it. */
export function useResource<T>(r: Resource<T> | null | undefined): T | undefined {
  return useStore<ResourceState<T>, T | undefined>(r ?? NONE, readyValue)
}
