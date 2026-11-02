/**
 * Utility functions for handling test command line flags
 */

/**
 * Check if a specific flag is present in the command line arguments
 * @param flag - The flag to check (e.g., '--profile', '-p')
 * @returns true if the flag is present
 */
export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

/**
 * Check if the profile flag is present
 * Supports: --profile, -p, or PROFILE environment variable
 * @returns true if profile mode should be enabled
 */
export function shouldProfile(): boolean {
  // Check for environment variable first (most reliable with vitest)
  if (process.env.PROFILE === "true") {
    return true
  }

  // Check for command line flags (may not work in all vitest setups)
  if (hasFlag("--profile") || hasFlag("-p")) {
    return true
  }

  // Check for any other profile-related environment variables
  if (process.env.VITEST_PROFILE === "true" || process.env.NODE_ENV === "profile") {
    return true
  }

  return false
}

/**
 * Get the value of a flag that takes a parameter
 * @param flag - The flag to check (e.g., '--env')
 * @returns the value after the flag, or undefined if not found
 */
export function getFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  if (index === -1 || index === process.argv.length - 1) {
    return undefined
  }
  return process.argv[index + 1]
}

/**
 * Check if verbose mode is enabled
 * Supports: --verbose, -v, or VITEST_VERBOSE environment variable
 * @returns true if verbose mode should be enabled
 */
export function shouldBeVerbose(): boolean {
  return hasFlag("--verbose") || hasFlag("-v") || process.env.VITEST_VERBOSE === "true"
}

/**
 * Log available flags for debugging
 */
export function logAvailableFlags(): void {
  console.log("Available command line arguments:", process.argv)
  console.log("Environment variables:")
  console.log("  PROFILE:", process.env.PROFILE)
  console.log("  VITEST_PROFILE:", process.env.VITEST_PROFILE)
  console.log("  VITEST_VERBOSE:", process.env.VITEST_VERBOSE)
  console.log("  NODE_ENV:", process.env.NODE_ENV)
}
