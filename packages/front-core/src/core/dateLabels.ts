/** Day and time labels for activity rows and chat separators, in the device's time zone. */
export function formatDateLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  ) {
    return "Today"
  }
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return "Yesterday"
  }
  const day = date.getDate().toString().padStart(2, "0")
  const month = date.toLocaleString("en-US", { month: "long" })
  return `${day} ${month}`
}

export function formatTimeLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const hh = date.getHours().toString().padStart(2, "0")
  const mm = date.getMinutes().toString().padStart(2, "0")
  return `${hh}:${mm}`
}
