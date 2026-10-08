import type { On } from 'claude-code'
import { test, expect } from 'claude-code/testing'

import { fakeHub } from './hub'

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
  // Regressions: wrappers with options, xargs, timeout, and a shell handed the command as a string.
  'sudo -E docker volume prune -f',
  'sudo -u root docker compose down -v',
  'docker volume ls -q | xargs -r docker volume rm',
  'timeout 60 docker volume prune -f',
  'nice -n 10 docker system prune --volumes',
  'bash -c "docker compose down -v"',
  "sh -c 'docker volume prune -f'",
  // The shared shell reader: GNU time, substitutions, heredocs fed to a shell, a shell inside a container.
  'time -f %e docker volume prune -f',
  'echo "$(docker volume rm pgdata)"',
  'bash <<EOF\ndocker compose down -v\nEOF',
  'docker exec ci sh -c "docker volume prune -f"',
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
  'bash -c "docker compose ps"',
  'timeout 30 docker compose up -d',
  "cat <<'EOF' > NOTES.md\ndocker compose down -v wipes the db\nEOF",
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

test('regression: PRUNE-OK does not carry into a turn the person did not start', async ($, on) => {
  engine(on)
  const command = 'docker compose down -v'
  await $.prompt.submit({ ...PERSON, text: 'reset my local db, PRUNE-OK' })
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  // Delivered into the approved turn: it stays approved.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' }, turnId: 'turn-1' })
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  // A notification that starts a turn of its own is not approved.
  await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
  expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('docker-prune-guard')
})

test('with mods-hub: a deny is published as risk.blocked with the rule and what would be lost', async ($, on) => {
  engine(on)
  const hub = fakeHub(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i += 1) await Promise.resolve() // the hello waits for session.start to return (afterStart)
  expect(hub.hellos).toEqual([{ version: 'unknown', publishes: ['risk.blocked'], consumes: [] }])
  expect((await $.tool.call({ tool: 'Bash', command: 'docker volume rm pgdata' })).deny).toContain('docker-prune-guard')
  expect((await $.tool.call({ tool: 'Bash', command: 'docker ps' })).deny).toBeUndefined()
  expect(hub.published).toEqual([
    {
      topic: 'risk.blocked',
      data: { guard: 'docker-prune-guard', tool: 'Bash', reason: 'volume-rm: would delete the volume pgdata and all the data in it', severity: 'medium', command: 'docker volume rm pgdata' },
    },
  ])
})
