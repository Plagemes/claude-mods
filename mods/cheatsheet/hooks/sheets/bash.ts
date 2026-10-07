import type { Sheet } from '../sheet'

export const bash: Sheet = {
  topic: 'bash',
  title: 'Bash',
  aliases: ['shell', 'sh', 'zsh'],
  summary: 'files, text tools, pipes, variables, scripting, readline keys',
  markdown: `## Files and directories
    ls -lah                       long listing, hidden files, human sizes
    cd -                          back to the previous directory
    mkdir -p a/b/c                create nested directories
    cp -r <src> <dst>             copy a directory
    mv <src> <dst>                move or rename
    rm -r <dir>                   delete a directory and everything in it (no undo)
    ln -s <target> <link>         symbolic link
    find . -name '*.log' -type f  find files by name
    du -sh *                      size of each item here
    df -h                         free space per disk
    chmod +x <file>               make a file executable (chmod 644, chmod 755 ...)

## Text tools
    less +F <file>                   follow a file like tail -f (Ctrl-c stops, q quits)
    tail -f <file>                   follow new lines
    head -n 20 <file>                first 20 lines
    grep -rn "text" .                search recursively with line numbers
    grep -rn --include='*.js' 'x' .  search only some files
    sed -i 's/old/new/g' <file>      replace in place (macOS: sed -i "" ...)
    awk '{print $1}' <file>          print the first column
    cut -d, -f1,3 <file>             columns 1 and 3 of a CSV
    sort | uniq -c | sort -rn        count duplicates, most frequent first
    wc -l <file>                     count lines
    xargs -n1 <cmd>                  run a command once per input line

## Pipes and redirects
    cmd > file    write stdout to a file (>> appends)
    cmd 2>&1      send stderr to the same place as stdout
    cmd &> file   stdout and stderr to a file
    cmd1 | cmd2   feed the output of one into the next
    cmd1 && cmd2  run cmd2 only if cmd1 succeeded
    cmd1 || cmd2  run cmd2 only if cmd1 failed
    $(cmd)        use the output of a command as text
    <(cmd)        a command's output as a file (diff <(a) <(b))
    cmd &         run in the background (jobs, fg, bg; Ctrl-z suspends)
    nohup cmd &   keep running after the terminal closes

## Variables and expansion
    name=value                     set a variable (no spaces around =)
    export NAME=value              make it visible to child processes
    "$name"                        use it; quote it unless you want word splitting
    \${name:-default}               default when unset or empty
    \${file%.txt}  \${file#*/}       strip a suffix, strip a prefix
    \${#name}                       length
    $?  $#  $@  $1                 last exit status, argument count, all arguments, first argument
    arr=(a b c); echo "\${arr[@]}"  arrays
    {a,b}.txt  {1..5}              brace expansion

## Scripting
    #!/usr/bin/env bash                      first line of a script
    set -euo pipefail                        stop on errors, unset variables and failed pipes
    if [[ -f "$f" ]]; then ...; fi           tests: -f file, -d dir, -e exists, -z empty, -n not empty
    for f in *.txt; do ...; done             loop over files
    while read -r line; do ...; done < file  loop over lines
    case "$x" in a) ...;; *) ...;; esac      switch
    name() { ...; }                          function; arguments are $1, $2 ...
    trap 'cleanup' EXIT                      run cleanup however the script ends
    read -r -p "Continue? " answer           ask for input

## Readline shortcuts
    Ctrl-a  Ctrl-e          start and end of the line
    Ctrl-w  Ctrl-u  Ctrl-k  delete the word before, everything before, everything after the cursor
    Ctrl-r                  search command history (again for the next match)
    Alt-b  Alt-f            back and forward one word
    !!  !$                  last command, last argument of the last command
    Alt-.                   insert the last argument again
    Ctrl-l                  clear the screen

## Processes
    ps aux | grep <name>       find a process
    kill <pid>  kill -9 <pid>  ask politely, then force
    pkill <name>               kill by name
    lsof -i :3000              what is using port 3000
    which <cmd>  type <cmd>    where a command comes from
    history | grep <text>      search past commands
`,
}
