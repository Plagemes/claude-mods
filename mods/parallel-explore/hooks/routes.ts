/** The model and tier smart-router routed each agent to, from the hub's `agent.routed` events, by agent id: `haiku · light`. */
export const routesOf = (feed: readonly { topic: string; data: unknown }[]): Map<string, string> => {
  const routes = new Map<string, string>()
  for (const { topic, data } of feed) {
    if (topic !== 'agent.routed' || typeof data !== 'object' || data === null) continue
    const { agentId, model, tier } = data as { agentId?: unknown; model?: unknown; tier?: unknown }
    if (typeof agentId === 'string' && typeof model === 'string') routes.set(agentId, typeof tier === 'string' ? `${model} · ${tier}` : model)
  }
  return routes
}
