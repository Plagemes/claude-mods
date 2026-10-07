import type { Sheet } from '../sheet'

export const tmux: Sheet = {
  topic: 'tmux',
  title: 'tmux',
  aliases: [],
  summary: 'sessions, windows, panes, copy mode, config',
  markdown: `## Sessions
    tmux new -s <name>           start a named session
    tmux ls                      list sessions
    tmux attach -t <name>        reattach (tmux a for the last one)
    tmux kill-session -t <name>  end a session
    prefix d                     detach and leave everything running
    prefix s                     pick a session from a list
    prefix $                     rename the session

## Windows (prefix is Ctrl-b by default)
    prefix c      new window
    prefix ,      rename the window
    prefix n | p  next or previous window
    prefix 0-9    jump to window by number
    prefix w      pick a window from a list
    prefix l      last window
    prefix &      close the window

## Panes
    prefix %                    split left and right
    prefix "                    split top and bottom
    prefix arrow                move to the pane in that direction
    prefix o                    next pane
    prefix z                    zoom the pane to full screen (again to restore)
    prefix x                    close the pane
    prefix { | }                swap the pane with the previous or next one
    prefix space                cycle through layouts
    prefix q                    show pane numbers
    prefix : resize-pane -L 10  resize (-L -R -U -D)

## Copy mode and buffers
    prefix [              enter copy mode: scroll with PageUp and the arrows, q leaves
    prefix ]              paste the most recent buffer
    / or ?                search forward or back in copy mode (vi keys)
    tmux capture-pane -p  print the visible pane to stdout

## Commands
    prefix :                       command prompt
    prefix ?                       list all key bindings
    tmux source-file ~/.tmux.conf  reload the config
    tmux kill-server               stop tmux and every session

## ~/.tmux.conf
    set -g mouse on                                       click panes, drag borders, scroll with the wheel
    set -g base-index 1                                   number windows from 1
    set -g history-limit 50000                            longer scrollback
    set -g mode-keys vi                                   vi keys in copy mode
    unbind C-b; set -g prefix C-a; bind C-a send-prefix   use Ctrl-a as the prefix
    bind r source-file ~/.tmux.conf \\; display "reloaded"  prefix r reloads the config
`,
}
