/**
 * Customizable Fetch Interceptor
 *
 * This module intercepts all fetch() calls, logs "hello!" to the console,
 * and returns a customizable mock JSON response.
 */

// Store the original fetch function
const originalFetch = global.fetch

// Default mock response
const defaultMockResponse = {
  success: true,
  message: "This is a mock response",
  data: {
    id: 1,
    name: "Mock Data",
    timestamp: new Date().toISOString(),
  },
}

// Configuration options
interface InterceptorConfig {
  // The mock response to return (can be a function that returns different responses based on the request)
  mockResponse?: unknown
  // HTTP status code to return (default: 200)
  statusCode?: number
  // Custom headers to include in the response
  headers?: Record<string, string>
  // Whether to log the request to the console
  logRequests?: boolean
  // Custom message to log (default: "hello!")
  logMessage?: string
  // Function to determine if a request should be intercepted (return false to use the original fetch)
  shouldIntercept?: (url: string, options?: RequestInit) => boolean
}

// Current configuration
let currentConfig: InterceptorConfig = {
  mockResponse: defaultMockResponse,
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  logRequests: true,
  logMessage: "hello!",
  shouldIntercept: () => true,
}

/**
 * Set up the fetch interceptor with custom configuration
 */
export function setupFetchInterceptor(config: InterceptorConfig = {}) {
  // Merge provided config with defaults
  currentConfig = { ...currentConfig, ...config }

  // Replace the global fetch with our interceptor
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString()

    // Check if we should intercept this request
    if (currentConfig.shouldIntercept && !currentConfig.shouldIntercept(url, init)) {
      return originalFetch(input, init)
    }

    // Log the message
    if (currentConfig.logMessage) {
      console.log(currentConfig.logMessage)
    }

    // Log the request details if enabled
    if (currentConfig.logRequests) {
      console.log(`Intercepted fetch request to: ${url}`)
      if (init) {
        console.log(`Method: ${init.method || "GET"}`)
        if (init.body) {
          console.log(`Body: ${init.body.toString()}`)
        }
      }
    }

    // Determine the response data
    let responseData = currentConfig.mockResponse
    if (typeof responseData === "function") {
      responseData = responseData(url, init)
    }

    // Convert to JSON string if it's an object
    const responseBody =
      typeof responseData === "object" ? JSON.stringify(responseData) : String(responseData)

    // Create a mock Response object
    return new Response(responseBody, {
      status: currentConfig.statusCode || 200,
      headers: currentConfig.headers || { "Content-Type": "application/json" },
    })
  }

  // Return the restore function
  return { restoreFetch }
}

/**
 * Update the interceptor configuration
 */
export function updateInterceptorConfig(config: InterceptorConfig) {
  currentConfig = { ...currentConfig, ...config }
}

/**
 * Restore the original fetch function
 */
export function restoreFetch() {
  global.fetch = originalFetch
}
