import { useLayoutEffect, useSyncExternalStore } from "react"
import {
  createPath,
  useNavigate,
  type NavigateFunction,
  type Navigator,
  type To,
} from "react-router-dom"
import { createExternalState } from "../lib/externalState"

/**
 * Taps the pre-boot screen takes for the wallet. "Create Account" waits for the landing the wallet
 * then shows, which runs it once. A route change is the wallet's router's to make: at once when it
 * is up, else as it starts.
 */
const create = createExternalState(false)
const left = createExternalState(false)
let pending: { to: string; replace: boolean } | undefined
let appNavigate: NavigateFunction | undefined

export function setPreBootCreate(on: boolean): void {
  create.set(on)
}

export function peekPreBootCreate(): boolean {
  return create.get()
}

/** Takes the tap, so it runs once. */
export function takePreBootCreate(): boolean {
  const on = create.get()
  create.set(false)
  return on
}

export function usePreBootCreate(): boolean {
  return useSyncExternalStore(create.subscribe, create.get)
}

/** The pre-boot screen navigated away; the boot screen waits for the route it went to. */
export function usePreBootLeft(): boolean {
  return useSyncExternalStore(left.subscribe, left.get)
}

const pathOf = (to: To) => (typeof to === "string" ? to : createPath(to))

/** The routes the pre-boot landing stands in for. */
const LANDING = ["/", "/claim"]

function leaveTo(to: To, replace: boolean): void {
  const path = pathOf(to)
  // The landing linking to itself stays up; the wallet still takes the route.
  if (!(LANDING.includes(location.pathname) && LANDING.includes(path))) left.set(true)
  if (appNavigate) appNavigate(path, { replace })
  else pending = { to: path, replace }
}

/** The pre-boot screen's router: its links and navigations become the wallet's. */
export const preBootNavigator: Navigator = {
  createHref: pathOf,
  push: (to) => leaveTo(to, false),
  replace: (to) => leaveTo(to, true),
  go: () => {},
}

/** Before the wallet's router first reads the URL. */
export function applyPreBootNavigation(): void {
  if (!pending) return
  if (pending.replace) history.replaceState(null, "", pending.to)
  else history.pushState(null, "", pending.to)
  pending = undefined
}

/** Inside the wallet's router: from here on the pre-boot screen navigates through it. */
export function PreBootRouterBridge(): null {
  const navigate = useNavigate()
  useLayoutEffect(() => {
    appNavigate = navigate
    return () => {
      if (appNavigate === navigate) appNavigate = undefined
    }
  }, [navigate])
  return null
}

export function __resetPreBootTapsForTests(): void {
  create.set(false)
  left.set(false)
  pending = undefined
  appNavigate = undefined
}
