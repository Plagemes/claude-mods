import type { Sheet } from '../sheet'

export const npm: Sheet = {
  topic: 'npm',
  title: 'npm',
  aliases: ['node', 'yarn', 'pnpm', 'npx'],
  summary: 'install, scripts, registry, publishing, audit, package.json',
  markdown: `## Install
    npm install              install everything in package.json (npm i)
    npm ci                   clean, exact install from the lockfile: use it in CI
    npm install <pkg>        add a dependency
    npm install -D <pkg>     add a dev dependency
    npm install <pkg>@1.2.3  a specific version (@latest, @beta also work)
    npm install -g <pkg>     install globally
    npm uninstall <pkg>      remove a dependency
    npm update               update within the ranges in package.json
    npm outdated             which packages have newer versions

## Look around
    npm ls --depth=0         top-level installed packages
    npm explain <pkg>        why a package is installed (npm why)
    npm view <pkg> versions  every published version (npm view <pkg> version for the latest)
    npm search <term>        search the registry
    npm config get registry  which registry is in use
    npm doctor               check your npm setup

## Scripts
    npm run                      list the scripts in package.json
    npm run <script>             run a script (npm test, npm start for the common ones)
    npm run build -- --watch     pass arguments after --
    npm run test -w <workspace>  run in one workspace (--workspaces for all)
    npx <pkg>                    run a package's binary without installing it globally
    node_modules/.bin            where the binaries of installed packages live

## Publish and versions
    npm version patch | minor | major  bump the version, commit and tag
    npm pack                           build the tarball that would be published
    npm publish --access public        publish (a scoped package needs --access public)
    npm dist-tag add <pkg>@1.2.3 beta  point a tag at a version
    npm login  npm whoami              sign in, check who you are
    npm link                           symlink a local package for development

## Audit and cleanup
    npm audit         report known vulnerabilities
    npm audit fix     apply compatible fixes (--force may break things)
    npm dedupe        flatten duplicate dependencies
    npm prune         remove packages not in package.json
    npm cache verify  check the cache (npm cache clean --force empties it)

## package.json
    "type": "module"                       treat .js files as ES modules
    "exports": { ".": "./dist/index.js" }  what importers can reach
    "files": ["dist"]                      what gets published
    "bin": { "tool": "./cli.js" }          commands the package installs
    "engines": { "node": ">=20" }          supported Node versions
    ^1.2.3  ~1.2.3  1.2.3                  compatible with 1.x.x, only 1.2.x, exactly this
`,
}
