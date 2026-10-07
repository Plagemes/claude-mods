# Contributing to claude-mods

Thank you for your interest in contributing to the claude-mods collection! This guide explains how to propose and add a new mod.

## How to Propose a Mod

Have an idea for a new mod? Open an issue using the **Mod Request** template. Describe the problem it solves and the behavior you envision. The maintainers will review your proposal and provide feedback.

## Mod Structure

Each mod follows a consistent file structure. Here's what your mod directory should contain:

```
mods/<name>/
├── .claude-plugin/
│   └── plugin.json          (mod metadata)
├── hooks/
│   ├── hooks.json           (hook configuration)
│   └── register.ts          (or .tsx; main implementation)
├── types/
│   └── index.d.ts           (optional; for $.state types)
├── tests/
│   └── *.test.ts            (optional; tests)
└── README.md                (documentation)
```

### `.claude-plugin/plugin.json`

Define your mod's metadata:

```json
{
  "name": "my-mod",
  "version": "1.0.0",
  "description": "Brief description of what the mod does",
  "author": "Your Name"
}
```

### `hooks/hooks.json`

Configure which modules export hooks:

```json
{
  "modules": ["./register.ts"]
}
```

### `hooks/register.ts(x)`

Export a `register` function from the `'claude-code'` module:

```typescript
import { Register } from 'claude-code';

export const register: Register = (claude) => {
  // Your hook implementations here
};
```

### `types/index.d.ts` (Optional)

If your mod uses `$.state`, define its shape:

```typescript
declare module 'claude-code' {
  interface ModState {
    // Your state type definitions
  }
}
```

### `tests/*.test.ts` (Optional)

Write tests for your mod using your preferred test framework.

### `README.md`

Document your mod:
- What problem it solves
- How to use it
- Configuration options (if any)
- Examples

## Before Submitting

Before opening a pull request, run these validation commands:

```bash
claude plugin validate mods/<name>
claude plugin test mods/<name>
```

Both must pass. Fix any issues before submitting.

## Adding Your Mod to the Catalog

Once your mod is ready, add it to `catalog.json` with these fields:

- **name**: The mod directory name (e.g., `my-mod`)
- **category**: One of the categories listed in the mod request template
- **tier**: Either `"simple"` (1-2 hooks) or `"complex"` (3+ hooks)
- **description**: One-line summary
- **spec**: Link to the mod's `.claude-plugin/plugin.json`

Example:

```json
{
  "name": "my-mod",
  "category": "Productivity",
  "tier": "simple",
  "description": "Helps you accomplish tasks more efficiently",
  "spec": "mods/my-mod/.claude-plugin/plugin.json"
}
```

After updating `catalog.json`, regenerate the marketplace and site data:

```bash
node scripts/build.mjs
```

## Code Conventions

- **TypeScript Strict**: All code must pass TypeScript in strict mode
- **Zero-Config Defaults**: Mods should work with no user configuration
- **Short Messages**: Keep user-facing messages concise
- **Guard Clauses**: Use `.catch()` to fail closed (safely) on errors
- **No Blocking Network**: Network calls must have timeouts; don't block the main thread
- **Performance**: Hooks should execute quickly to avoid slowing down Claude

## Development Loop

To test your mod locally during development:

```bash
claude --plugin-dir mods/<name>
```

This loads your mod without installation, allowing rapid iteration.

## Pull Request Checklist

Before submitting, ensure:

- [ ] `claude plugin validate mods/<name>` passes
- [ ] `claude plugin test mods/<name>` passes
- [ ] `README.md` is up to date
- [ ] `catalog.json` is updated
- [ ] `node scripts/build.mjs` has been run

## Questions?

Open an issue or see our showcase site at https://plagemes.github.io/claude-mods/.
