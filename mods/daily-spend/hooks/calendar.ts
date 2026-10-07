const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local date as the store keys it: `2026-10-07`, which also sorts by time. */
export const dayKey = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** The `count` local days ending today, oldest first. */
export const lastDays = (now: number, count: number): Date[] => {
  const today = new Date(now)

  return Array.from(
    { length: count },
    (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1 - i)),
  )
}

/** The Monday that starts the local week holding `now`. */
export const weekStart = (now: number): Date => {
  const today = new Date(now)

  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7))
}

/** `7 Oct` */
export const shortDate = (date: Date): string => `${date.getDate()} ${MONTHS[date.getMonth()] ?? ''}`

/** `Wed 7` */
export const weekdayDate = (date: Date): string => `${WEEKDAYS[date.getDay()] ?? ''} ${date.getDate()}`
