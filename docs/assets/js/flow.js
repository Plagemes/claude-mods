// "How mods work": draws the wires from events, through the hook, to what you see.
const NS = 'http://www.w3.org/2000/svg'

export function initFlow(root) {
  if (!root) return
  const svg = root.querySelector('[data-flow-wires]')
  const inputs = [...root.querySelectorAll('[data-flow-in] li')]
  const outputs = [...root.querySelectorAll('[data-flow-out] li')]
  const hook = root.querySelector('[data-flow-hook]')

  function draw() {
    if (getComputedStyle(svg).display === 'none') return
    const box = root.getBoundingClientRect()
    const h = hook.getBoundingClientRect()
    const hookLeft = h.left - box.left
    const hookRight = h.right - box.left
    const hookMid = h.top - box.top + h.height / 2
    const paths = []

    inputs.forEach((li, i) => {
      const r = li.getBoundingClientRect()
      const x1 = r.right - box.left
      const y1 = r.top - box.top + r.height / 2
      const y2 = hookMid + (i - (inputs.length - 1) / 2) * 10
      paths.push(curve(x1, y1, hookLeft, y2))
    })
    outputs.forEach((li, i) => {
      const r = li.getBoundingClientRect()
      const x2 = r.left - box.left
      const y2 = r.top - box.top + r.height / 2
      const y1 = hookMid + (i - (outputs.length - 1) / 2) * 10
      paths.push(curve(hookRight, y1, x2, y2))
    })

    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`)
    svg.replaceChildren(...paths.flatMap((d, i) => {
      const wire = document.createElementNS(NS, 'path')
      wire.setAttribute('d', d)
      wire.setAttribute('class', 'wire')
      const pulse = document.createElementNS(NS, 'path')
      pulse.setAttribute('d', d)
      pulse.setAttribute('class', 'pulse')
      pulse.setAttribute('pathLength', '400')
      pulse.style.setProperty('--i', String(i < inputs.length ? i : i - inputs.length + 0.5))
      return [wire, pulse]
    }))
  }

  function curve(x1, y1, x2, y2) {
    const dx = (x2 - x1) * 0.55
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`
  }

  draw()
  if ('ResizeObserver' in window) new ResizeObserver(() => draw()).observe(root)
  else window.addEventListener('resize', draw)
  document.fonts?.ready.then(draw)
}
