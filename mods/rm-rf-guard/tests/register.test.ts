import { test, expect } from 'claude-code/testing'

const BLOCKED = [
  'rm -rf /',
  'rm   -rf    /',
  'sudo rm -rf --no-preserve-root /',
  'rm -fr /*',
  'rm -rf ~',
  'rm -rf ~/',
  'rm -rf "$HOME"',
  'rm -rf ${HOME}/*',
  'rm -r *',
  'rm -rf ./*',
  'rm -rf ..',
  'rm -rf /usr/',
  'rm -rf /etc',
  'rm -Rf /home/alice',
  'cd /tmp && rm --recursive --force /',
  'git reset --hard',
  'git reset --hard origin/main',
  'git -C app clean -fdx',
  'git clean -fd',
  'mkfs.ext4 /dev/sda1',
  'mkfs -t ext4 /dev/sdb',
  'dd if=/dev/zero of=/dev/sda bs=1M',
  'cat image.iso > /dev/sdb',
  'chmod -R 777 .',
  'chmod -R a+rwx /var/www',
  'chown -R nobody /',
  'chmod -R 755 /usr',
  ':(){ :|:& };:',
  'find / -delete',
  'wipefs -a /dev/nvme0n1',
]

const ALLOWED = [
  'rm -rf node_modules',
  'rm -rf ./build dist',
  'rm -rf /tmp/scratch',
  'rm -rf ~/projects/old-thing',
  'rm -r src/*',
  'rm file.txt',
  'git reset --soft HEAD~1',
  'git reset HEAD file.txt',
  'git clean -n -fd',
  'git clean -f',
  'git status',
  'dd if=/dev/zero of=./disk.img bs=1M count=10',
  'dd if=big.iso of=/dev/null',
  'chmod -R u+rwX,go+rX ./public',
  'chmod 777 script.sh',
  'chown -R me:me ./project',
  'echo "never run rm -rf /"',
  'grep -r "rm -rf" docs/',
  'find . -name "*.orig" -delete',
  'ls -la /',
]

test('denies catastrophic commands with an explanation and a safer alternative', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  for (const command of BLOCKED) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'ALLOWED'}`).toContain('rm-rf-guard: blocked')
    expect(result.deny).toContain('Instead:')
  }
})

test('lets everyday destructive-looking commands through to the tool', async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  for (const command of ALLOWED) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(`${command} => ${result.deny ?? 'allowed'}`).toBe(`${command} => allowed`)
    expect(result.result).toBe('ran')
  }
})

test('allowGitReset permits git reset --hard and git clean -fdx but never rm -rf /', { options: { allowGitReset: true } }, async ($, on) => {
  on('tool.call', () => ({ result: 'ran' }))
  expect((await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~1' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git clean -fdx' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'rm -rf /' })).deny).toContain('rm-rf-guard')
})
