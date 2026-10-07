import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

const PERSON = { wait: false, origin: { kind: 'composer' } } as const

/** Stands in for the engine: records the commands that reach the Bash tool and lets prompts through. */
function engine(on: On) {
  const ran: string[] = []
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    return { result: 'ran' }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return ran
}

const RISKY = [
  'docker system prune -a --volumes',
  'docker system prune --volumes -f',
  'docker system prune -af',
  'docker system prune --all',
  'docker volume prune',
  'docker volume prune -f',
  'docker volume rm pgdata',
  'docker volume remove pgdata redisdata',
  'docker compose down -v',
  'docker compose down --volumes --remove-orphans',
  'docker compose -f docker-compose.dev.yml down -v',
  'docker-compose down -v',
  'docker-compose down --rmi all -v',
  'docker compose rm -fsv db',
  'docker rm -fv postgres',
  'docker container rm -v postgres',
  'podman system prune --volumes',
  'podman volume prune',
  'podman-compose down -v',
  'sudo docker system prune -a',
  'cd infra && docker compose down -v && docker compose up -d',
  'docker --context remote volume prune',
]

const SAFE = [
  'docker system prune',
  'docker system prune -f',
  'docker system df',
  'docker image prune -a',
  'docker builder prune',
  'docker container prune',
  'docker volume ls',
  'docker volume inspect pgdata',
  'docker volume create pgdata',
  'docker compose down',
  'docker compose down --remove-orphans',
  'docker compose up -d',
  'docker compose -f ci.yml up -d',
  'docker-compose stop',
  'docker rm postgres',
  'docker run --rm -v pgdata:/data alpine ls /data',
  'docker ps -a',
  'podman ps',
  'echo "docker compose down -v"',
  'git commit -m "docker volume prune notes"',
  'ls -la',
]

test('denies commands that can delete volumes or every unused image, and says what would be lost', async ($, on) => {
  const ran = engine(on)
  for (const command of RISKY) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('docker-prune-guard')
    expect(result.deny).toContain('would delete')
    expect(result.deny).toContain('Safer:')
    expect(result.deny).toContain('PRUNE-OK')
  }
  expect(ran).toHaveLength(0)
})

test('leaves ordinary docker commands alone', async ($, on) => {
  const ran = engine(on)
  for (const command of SAFE) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'allowed'}`).toBe(`${command} => allowed`)
  }
  expect(ran).toHaveLength(SAFE.length)
})

test('names the loss that matches the command', async ($, on) => {
  engine(on)
  const volumes = await $.tool.call({ tool: 'Bash', command: 'docker system prune -a --volumes' })
  expect(volumes.deny).toContain('database')
  expect(volumes.deny).toContain('docker system df')
  const images = await $.tool.call({ tool: 'Bash', command: 'docker system prune -a' })
  expect(images.deny).toContain('pulled or built again')
  const named = await $.tool.call({ tool: 'Bash', command: 'docker volume rm pgdata' })
  expect(named.deny).toContain('the volume pgdata')
  const substituted = await $.tool.call({ tool: 'Bash', command: 'docker volume rm $(docker volume ls -q)' })
  expect(substituted.deny).toContain('the volumes the command names')
  const several = await $.tool.call({ tool: 'Bash', command: 'docker volume prune && docker compose down -v' })
  expect(several.deny).toContain('1 more risky command')
})

test('PRUNE-OK in the latest message from the person opens the gate, the next message closes it', async ($, on) => {
  const ran = engine(on)
  const command = 'docker compose down -v'
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('docker-prune-guard')

  await $.prompt.submit({ ...PERSON, text: 'reset my local db, PRUNE-OK' })
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  expect(ran).toEqual([command])

  await $.prompt.submit({ ...PERSON, text: 'now run the tests' })
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('docker-prune-guard')
})

test('PRUNE-OK from a notification or another plugin is not an approval', async ($, on) => {
  engine(on)
  await $.prompt.submit({ text: 'PRUNE-OK', wait: false, origin: { kind: 'task-notification' } })
  await $.prompt.submit({ text: 'PRUNE-OK', wait: false, origin: { kind: 'plugin', name: 'other' } })
  expect((await $.tool.call({ tool: 'Bash', command: 'docker volume prune -f' })).deny).toContain('docker-prune-guard')
})
