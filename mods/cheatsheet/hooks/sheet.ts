/** One cheat sheet: Markdown with `## Section` headings and 4-space-indented lines (`command  what it does`). */
export type Sheet = {
  /** The word `/cheat` takes. */
  topic: string
  title: string
  /** Other words that name the same sheet. */
  aliases: readonly string[]
  /** One line for the topic list. */
  summary: string
  markdown: string
}
