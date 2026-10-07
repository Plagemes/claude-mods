import type { Sheet } from '../sheet'

export const vim: Sheet = {
  topic: 'vim',
  title: 'Vim',
  aliases: ['vi', 'nvim', 'neovim'],
  summary: 'modes, motions, editing, search and replace, windows, macros',
  markdown: `## Modes
    i  a             insert before or after the cursor
    I  A             insert at the start or end of the line
    o  O             open a new line below or above
    Esc  or  Ctrl-[  back to normal mode
    v  V  Ctrl-v     select characters, lines, a block
    R                replace mode: overtype
    :                command line

## Move
    h  j  k  l      left, down, up, right
    w  b  e         next word, previous word, end of word
    0  ^  $         start of line, first non-blank, end of line
    gg  G  42G      first line, last line, line 42
    %               jump to the matching bracket
    Ctrl-d  Ctrl-u  half a page down or up
    H  M  L         top, middle, bottom of the screen
    zz              center the cursor line
    f<c>  ;         jump to the next character c on the line, repeat
    *  #            next or previous occurrence of the word under the cursor

## Edit
    x              delete the character
    dd  D          delete the line, delete to end of line
    dw  cw         delete or change a word
    ciw  ci"  ci(  change inside a word, quotes, parentheses
    yy  yw         yank (copy) a line or word
    p  P           paste after or before the cursor
    u  Ctrl-r      undo, redo
    .              repeat the last change
    >>  <<         indent or outdent the line
    J              join the next line onto this one
    ~              toggle case
    r<c>           replace one character with c
    3dd  d3w  y2j  counts work with most commands

## Search and replace
    /text  ?text    search forward or backward
    n  N            next or previous match
    :%s/old/new/g   replace in the whole file
    :%s/old/new/gc  replace, asking for each one
    :s/old/new/     replace on the current line
    :noh            clear search highlighting

## Files, buffers, windows
    :w  :q  :wq  ZZ          save, quit, save and quit, save and quit
    :q!                      quit and discard changes
    :e <file>                open a file
    :ls  :bn  :bp            list buffers, next, previous
    :sp <file>  :vsp <file>  split horizontally or vertically
    Ctrl-w h j k l           move between windows
    Ctrl-w q                 close the window
    :tabnew  gt  gT          new tab, next tab, previous tab

## Macros and extras
    qa ... q                    record a macro into register a
    @a  @@                      play it, play it again
    ma  'a                      set mark a, jump back to its line
    gv                          reselect the last selection
    :!<cmd>                     run a shell command
    :r <file>                   insert a file below the cursor
    :set number relativenumber  show line numbers
    :help <topic>               built-in help
`,
}
