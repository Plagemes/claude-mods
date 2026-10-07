# jwt-decode
> /jwt decodes a JSON Web Token locally — header, claims, expiry — without sending it anywhere.

**Category:** APIs & Network · **Version:** 1.0.0

## What it does
`/jwt <token>` base64url-decodes a token inside the plugin and prints its header and claims as pretty JSON, shows `iat`, `nbf` and `exp` as UTC dates with how far away they are (`expired 2 h 5 min ago`, `valid for 14 min more`), and lists warnings: `alg: none`, an `HS256` token signed with a well-known sample secret (the plugin recomputes the HMAC for about 45 guessable secrets, including jwt.io's `your-256-bit-secret`), key locations in the header (`jku`, `x5u`, `jwk`), no `exp`, lifetimes over 30 days, and times written in milliseconds. No network request is made and nothing is written to the store or a file. The signature is not verified: that needs the issuer's key.

## Install
```
/plugin marketplace add plagemes/claude-mods
/plugin install jwt-decode@claude-mods
```

## Usage
```
/jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
/jwt                      decodes what you last selected with the mouse
/jwt Authorization: Bearer eyJ...    the token may come wrapped in a header, quotes or a curl line
```
The output starts `JWT · alg HS256 · typ JWT` and continues with Header, Claims, Times and Notes. A payload that is not JSON is shown as text; an encrypted token (JWE, five parts) shows its header and says its payload cannot be read.

Privacy: a slash command and its output become part of the conversation like any other. The output holds the header and claims but never the token itself, and a `session.append` hook takes any token out of the stored record of the command (the one with your argument) before it is kept or sent to the model. That removal is best effort: it matches command records that mention `jwt`. Decoded claims (email, user id) do reach the conversation, so do not decode a production token whose claims are private.

## Configuration
No configuration needed.

## How it works
- Hooks `command.run` for `/jwt`: base64url and UTF-8 decoding and SHA-256/HMAC are implemented in the plugin, with `$.clock` for the current time and `$.ui.selection()` when no argument is given. Hooks `session.append` for command records only, to replace JWT-shaped strings with `[JWT removed by jwt-decode]`.
- Failing is harmless: if the redaction hook errors the record is stored as it was, and `/jwt` itself only reads.
- Limits: the weak-secret check covers HS256 only (HS384 and HS512 are reported as symmetric); signatures are never verified; token parts must be valid base64url.
