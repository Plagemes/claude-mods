/** The marker Claude leaves for the person to complete. */
export const MARKER = 'TODO(you)'

/** Folders and file names where a gap left for a learner could become a vulnerability. */
const SECURITY_PATH =
  /(?:^|[/\\_.-])(?:auth|authn|authz|authentication|authorization|crypto|cipher|encrypt|encryption|decrypt|secret|secrets|password|passwords|passwd|token|tokens|jwt|oauth|saml|session|sessions|security|permission|permissions|acl|csrf|sanitize|sanitizer|payment|payments|billing)(?:[/\\_.-]|$)/i

export const isSecurityCritical = (path: string): boolean => SECURITY_PATH.test(path)

export const countMarkers = (text: string): number => text.split(MARKER).length - 1

/** How many markers a change adds: the new text's markers minus the ones the replaced text already had. */
export const addedMarkers = (before: string, after: string): number => Math.max(0, countMarkers(after) - countMarkers(before))

export const instructions = (maxTodos: number): string =>
  [
    'Learning mode is on: the user wants to learn from this work, not just receive it.',
    '- Explain the why behind each change briefly: the reasoning and the trade-off, in a sentence or two. No lectures.',
    `- For up to ${maxTodos} small, well-scoped pieces per task (a helper, a condition, a mapping, a test case) leave a \`${MARKER}: <hint>\` comment instead of the code. ` +
      'The hint says what to use or which edge case to handle. Choose pieces that teach something, and tell the user in your answer what is left for them.',
    `- Never leave ${MARKER} in security-critical code: authentication, authorization, cryptography, secrets, input validation, payments. Write that code completely.`,
    '- Everything else, including the code around a marker, must be complete and working, so the user only fills in the marked pieces.',
    `- Use the file's own comment syntax (\`// ${MARKER}: ...\`, \`# ${MARKER}: ...\`).`,
  ].join('\n')

/** The toast after a turn that left markers: `3 TODO(you) left for you: src/a.ts (2), src/b.ts`. */
export const summary = (byFile: ReadonlyMap<string, number>, maxTodos: number): string => {
  const total = [...byFile.values()].reduce((sum, n) => sum + n, 0)
  const names = [...byFile].map(([path, n]) => `${path.split(/[/\\]/).pop() ?? path}${n > 1 ? ` (${n})` : ''}`)
  const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3} more` : names.join(', ')
  const over = total > maxTodos ? ` · more than the ${maxTodos} asked for` : ''
  return `🎓 ${total} ${MARKER} left for you: ${shown}${over}`
}
