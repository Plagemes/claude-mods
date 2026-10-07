import type { Sheet } from '../sheet'

export const regex: Sheet = {
  topic: 'regex',
  title: 'Regular expressions',
  aliases: ['regexp', 'rx'],
  summary: 'syntax, groups, lookaround, flags, ready-made patterns',
  markdown: String.raw`## Characters
    .               any character except a newline
    \d  \w  \s      digit, word character (letter, digit, _), whitespace
    \D  \W  \S      the opposite of each
    [abc]           one of a, b or c
    [^abc]          anything but a, b or c
    [a-z0-9]        a range
    \.  \*  \(  \\  escape a special character to match it literally

## Anchors
    ^  $  start and end of the text (of each line with the m flag)
    \b    word boundary
    \B    not a word boundary

## Quantifiers
    *           zero or more
    +           one or more
    ?           zero or one
    {3}         exactly 3
    {2,}        2 or more
    {2,5}       between 2 and 5
    *?  +?  ??  lazy: match as little as possible

## Groups
    (abc)           capture group
    (?:abc)         group without capturing
    (?<year>\d{4})  named group (Python: (?P<year>...))
    \1              whatever the first group matched again (backreference)
    a|b             a or b

## Lookaround
    (?=x)   followed by x (lookahead)
    (?!x)   not followed by x
    (?<=x)  preceded by x (lookbehind)
    (?<!x)  not preceded by x

## Flags
    i  ignore case
    g  all matches, not just the first (JavaScript)
    m  multiline: ^ and $ match at every line
    s  dotall: . also matches newlines
    x  verbose: whitespace and comments allowed (Python, PCRE)
    u  Unicode mode (JavaScript)

## Ready-made patterns
    ^\d{4}-\d{2}-\d{2}$            date shaped like 2026-10-07 (does not check it is a real date)
    ^[\w.+-]+@[\w-]+\.[\w.-]+$     rough email shape
    https?://\S+                   URL up to the next whitespace
    ^\s+|\s+$                      leading and trailing whitespace (for trimming)
    \s{2,}                         runs of whitespace
    (\d+)\.(\d+)\.(\d+)            major, minor, patch of a version number
    ^#?([0-9a-f]{6}|[0-9a-f]{3})$  hex color (with the i flag)
    (?<=\$)\d+(\.\d\d)?            amount after a dollar sign

## In tools
    grep -E 'a|b' file            extended regex (grep -P for Perl syntax)
    rg 'pattern' src/             ripgrep: regex by default
    sed -E 's/(a)(b)/\2\1/' file  replace with groups (\1, \2)
    'a1b2'.replace(/\d/g, '#')    JavaScript replace; $1 and $<name> in the replacement
    re.findall(r'\d+', text)      Python: all matches (re.sub, re.search, re.compile)
`,
}
