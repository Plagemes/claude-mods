import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage } from 'claude-code'

import type { ContextGaugeFill } from '../types'

const fill = atom({ plugin: 'context-gauge', key: 'fill' } as const, null)
const isHidden = atom({ plugin: 'context-gauge', key: 'isHidden' } as const, false)

const BAR_CELLS = 20
const DEFAULT_WARN_AT = 60
const DEFAULT_ALERT_AT = 75

const toFill = ({ percent, tokens, window }: SessionContextUsage): ContextGaugeFill | null =>
  percent === undefined || tokens === undefined ? null : { percent, tokens, window }

const compactNumber = (n: number): string =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n}`

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

export const register: Register = (on, options) => {
  const warnAt = asNumber(options.warnAt, DEFAULT_WARN_AT)
  const alertAt = asNumber(options.alertAt, DEFAULT_ALERT_AT)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-gauge',
      description: 'Show or hide the context-window gauge above the prompt',
    })

    try {
      const { context } = await $.session.usage()
      await update($, fill, () => toFill(context))
    } catch {
      // The gauge simply stays hidden until the first measurement arrives.
    }

    return next(e)
  })

  on('command.run', { command: 'context-gauge' }, async $ => {
    const willHide = !(await read($, isHidden))
    await update($, isHidden, () => willHide)

    return { text: willHide ? 'Context gauge hidden.' : 'Context gauge shown.' }
  })

  on('session.measure', async ($, e, next) => {
    await update($, fill, () => toFill(e.context))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, fill, () => null)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const gauge = await read($, fill)

    if (e.props.hasSurvey || gauge === null || (await read($, isHidden))) {
      return next(e)
    }

    // The band holds one tree: what the plugins beneath draw goes under the gauge, so their bands still show.
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const percent = Math.min(100, Math.max(0, Math.round(gauge.percent)))
    const filled = Math.round((percent / 100) * BAR_CELLS)
    const needsCompact = percent > alertAt
    const color = needsCompact ? 'error' : percent >= warnAt ? 'warning' : 'success'

    return (
      <Box flexDirection="column">
        <Box key="gauge">
          <Text dimColor>context </Text>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(BAR_CELLS - filled)}</Text>
          <Text color={color}>{` ${percent}%`}</Text>
          <Text dimColor>{` ${compactNumber(gauge.tokens)}/${compactNumber(gauge.window)}`}</Text>
          {needsCompact && <Text color={color}>{'  /compact'}</Text>}
          <Text> </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })
}
