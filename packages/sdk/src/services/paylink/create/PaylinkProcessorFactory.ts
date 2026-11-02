import { type ContractName, DEFAULT_CONTRACTS } from "../../../index.js"
import type { BasePaylinkProcessor } from "./processors/BasePaylinkProcessor.js"
import { DirectPaylinkProcessor } from "./processors/DirectPaylinkProcessor.js"
import { EmailPaylinkProcessor } from "./processors/EmailPaylinkProcessor.js"

/**
 * Factory for creating paylink processors based on type
 * Implements the Factory Pattern for clean separation of concerns
 */
export class PaylinkProcessorFactory {
  // Cache processors for reuse (they are stateless)
  private static processors: Map<ContractName, BasePaylinkProcessor> = new Map()

  /**
   * Create or retrieve a processor for the given paylink type
   * @param type - The paylink type
   * @returns The appropriate processor instance
   * @throws Error if the paylink type is not supported
   */
  static create(type: ContractName): BasePaylinkProcessor {
    // Return cached processor if exists
    const cached = this.processors.get(type)
    if (cached) {
      return cached
    }

    // Create new processor based on type
    let processor: BasePaylinkProcessor

    switch (type) {
      case DEFAULT_CONTRACTS.paylinkEmail:
        processor = new EmailPaylinkProcessor()
        break

      case DEFAULT_CONTRACTS.paylinkDirect:
        processor = new DirectPaylinkProcessor()
        break

      default:
        throw new Error(`Unsupported paylink type: ${type}`)
    }

    // Cache and return
    this.processors.set(type, processor)
    return processor
  }

  /**
   * Get all supported paylink types
   * @returns Array of supported paylink types
   */
  static getSupportedTypes(): ContractName[] {
    return [DEFAULT_CONTRACTS.paylinkEmail, DEFAULT_CONTRACTS.paylinkDirect]
  }

  /**
   * Check if a paylink type is supported
   * @param type - The paylink type to check
   * @returns True if supported, false otherwise
   */
  static isSupported(type: ContractName): boolean {
    return this.getSupportedTypes().includes(type)
  }

  /**
   * Clear the processor cache
   * Useful for testing
   */
  static clearCache(): void {
    this.processors.clear()
  }
}
