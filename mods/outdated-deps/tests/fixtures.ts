// Real output of npm 10 outdated --json --long, pnpm 10 outdated --format json, yarn 1.22 outdated --json,
// pip 26 list --outdated --format=json, cargo-outdated 0.19 --root-deps-only and go 1.24 list -u -m -json all
// (main module, direct requirements and two indirect ones kept) on demo projects with old dependencies.

export const NPM_OUTDATED = String.raw`{
  "@types/node": {
    "current": "18.0.0",
    "wanted": "18.19.130",
    "latest": "26.6.4",
    "dependent": "outdated-npm",
    "location": "/home/dev/outdated-npm/node_modules/@types/node",
    "type": "devDependencies",
    "homepage": "https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node"
  },
  "debug": {
    "current": "4.3.1",
    "wanted": "4.4.3",
    "latest": "4.4.3",
    "dependent": "outdated-npm",
    "location": "/home/dev/outdated-npm/node_modules/debug",
    "type": "dependencies",
    "homepage": "https://github.com/debug-js/debug#readme"
  },
  "express": {
    "current": "4.17.1",
    "wanted": "4.22.3",
    "latest": "5.2.1",
    "dependent": "outdated-npm",
    "location": "/home/dev/outdated-npm/node_modules/express",
    "type": "dependencies",
    "homepage": "https://expressjs.com/"
  },
  "lodash": {
    "current": "4.17.15",
    "wanted": "4.18.1",
    "latest": "4.18.1",
    "dependent": "outdated-npm",
    "location": "/home/dev/outdated-npm/node_modules/lodash",
    "type": "dependencies",
    "homepage": "https://lodash.com/"
  },
  "ms": {
    "current": "2.1.2",
    "wanted": "2.1.3",
    "latest": "2.1.3",
    "dependent": "outdated-npm",
    "location": "/home/dev/outdated-npm/node_modules/ms",
    "type": "dependencies",
    "homepage": "https://github.com/vercel/ms#readme"
  },
  "react": {
    "current": "17.0.2",
    "wanted": "17.0.2",
    "latest": "19.3.0",
    "dependent": "outdated-npm",
    "location": "/home/dev/outdated-npm/node_modules/react",
    "type": "dependencies",
    "homepage": "https://react.dev/"
  },
  "request": {
    "current": "2.88.0",
    "wanted": "2.88.2",
    "latest": "2.88.2",
    "dependent": "outdated-npm",
    "location": "/home/dev/outdated-npm/node_modules/request",
    "type": "dependencies",
    "homepage": "https://github.com/request/request#readme"
  },
  "typescript": {
    "current": "4.9.4",
    "wanted": "4.9.5",
    "latest": "7.0.2",
    "dependent": "outdated-npm",
    "location": "/home/dev/outdated-npm/node_modules/typescript",
    "type": "devDependencies",
    "homepage": "https://www.typescriptlang.org/"
  }
}
`

export const PNPM_OUTDATED = String.raw`{
  "request": {
    "current": "2.88.2",
    "latest": "2.88.2",
    "wanted": "2.88.2",
    "isDeprecated": true,
    "dependencyType": "dependencies"
  },
  "minimist": {
    "current": "1.2.0",
    "latest": "1.2.8",
    "wanted": "1.2.0",
    "isDeprecated": false,
    "dependencyType": "devDependencies"
  },
  "lodash": {
    "current": "4.17.15",
    "latest": "4.18.1",
    "wanted": "4.17.15",
    "isDeprecated": false,
    "dependencyType": "dependencies"
  },
  "@sindresorhus/slugify": {
    "current": "1.1.0",
    "latest": "3.0.1",
    "wanted": "1.1.0",
    "isDeprecated": false,
    "dependencyType": "dependencies"
  },
  "@types/node": {
    "current": "18.0.0",
    "latest": "26.6.4",
    "wanted": "18.0.0",
    "isDeprecated": false,
    "dependencyType": "devDependencies"
  },
  "express": {
    "current": "4.17.1",
    "latest": "5.2.1",
    "wanted": "4.17.1",
    "isDeprecated": false,
    "dependencyType": "dependencies"
  }
}
`

export const YARN_OUTDATED = String.raw`{"type":"info","data":"Color legend : \n \"<red>\"    : Major Update backward-incompatible updates \n \"<yellow>\" : Minor Update backward-compatible features \n \"<green>\"  : Patch Update backward-compatible bug fixes"}
{"type":"table","data":{"head":["Package","Current","Wanted","Latest","Package Type","URL"],"body":[["@sindresorhus/slugify","1.1.0","1.1.0","3.0.1","dependencies","https://github.com/sindresorhus/slugify#readme"],["@types/node","18.0.0","18.0.0","26.6.4","devDependencies","https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node"],["express","4.17.1","4.17.1","5.2.1","dependencies","https://expressjs.com/"],["lodash","4.17.15","4.17.15","4.18.1","dependencies","https://lodash.com/"],["minimist","1.2.0","1.2.0","1.2.8","devDependencies","https://github.com/minimistjs/minimist"]]}}
`

export const PIP_OUTDATED = String.raw`[{"name": "chardet", "version": "4.0.0", "latest_version": "7.6.0", "latest_filetype": "wheel"}, {"name": "Flask", "version": "2.0.0", "latest_version": "3.1.3", "latest_filetype": "wheel"}, {"name": "idna", "version": "2.10", "latest_version": "3.20", "latest_filetype": "wheel"}, {"name": "requests", "version": "2.25.1", "latest_version": "2.34.2", "latest_filetype": "wheel"}, {"name": "six", "version": "1.15.0", "latest_version": "1.17.0", "latest_filetype": "wheel"}, {"name": "urllib3", "version": "1.26.20", "latest_version": "2.8.0", "latest_filetype": "wheel"}]
`

export const CARGO_OUTDATED = String.raw`{"crate_name":"demo-rs","dependencies":[{"name":"time","project":"0.1.45","compat":"---","latest":"0.3.55","kind":"Normal","platform":null}]}
`

export const GO_LIST = String.raw`{
	"Path": "example.com/demo",
	"Main": true,
	"Dir": "/home/dev/go",
	"GoMod": "/home/dev/go/go.mod",
	"GoVersion": "1.22"
}
{
	"Path": "github.com/gin-gonic/gin",
	"Version": "v1.7.0",
	"Time": "2021-04-08T07:47:41Z",
	"Update": {
		"Path": "github.com/gin-gonic/gin",
		"Version": "v1.12.0",
		"Time": "2026-02-28T10:10:09Z"
	},
	"Dir": "/root/go/pkg/mod/github.com/gin-gonic/gin@v1.7.0",
	"GoMod": "/root/go/pkg/mod/cache/download/github.com/gin-gonic/gin/@v/v1.7.0.mod",
	"GoVersion": "1.13",
	"Sum": "h1:jGB9xAJQ12AIGNB4HguylppmDK1Am9ppF7XnGXXJuoU=",
	"GoModSum": "h1:jD2toBW3GZUr5UMcdrwQA10I7RuaFOl/SGeDjXkfUtY="
}
{
	"Path": "github.com/google/uuid",
	"Version": "v1.3.0",
	"Time": "2021-07-12T22:33:52Z",
	"Update": {
		"Path": "github.com/google/uuid",
		"Version": "v1.6.0",
		"Time": "2024-01-23T18:54:04Z"
	},
	"Dir": "/root/go/pkg/mod/github.com/google/uuid@v1.3.0",
	"GoMod": "/root/go/pkg/mod/cache/download/github.com/google/uuid/@v/v1.3.0.mod",
	"Sum": "h1:t6JiXgmwXMjEs8VusXIJk2BXHsn+wx8BZdTaoZ5fu7I=",
	"GoModSum": "h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo="
}
{
	"Path": "golang.org/x/text",
	"Version": "v0.3.7",
	"Time": "2021-08-10T18:28:16Z",
	"Update": {
		"Path": "golang.org/x/text",
		"Version": "v0.42.0",
		"Time": "2026-09-08T16:29:55Z"
	},
	"Dir": "/root/go/pkg/mod/golang.org/x/text@v0.3.7",
	"GoMod": "/root/go/pkg/mod/cache/download/golang.org/x/text/@v/v0.3.7.mod",
	"GoVersion": "1.17",
	"Sum": "h1:olpwvP2KacW1ZWvsR7uQhoyTYvKAupfQrRGBFM352Gk=",
	"GoModSum": "h1:u+2+/6zg+i71rQMx5EYifcz6MCKuco9NR6JIITiCfzQ="
}
{
	"Path": "github.com/davecgh/go-spew",
	"Version": "v1.1.1",
	"Time": "2018-02-21T23:26:28Z",
	"Indirect": true,
	"Dir": "/root/go/pkg/mod/github.com/davecgh/go-spew@v1.1.1",
	"GoMod": "/root/go/pkg/mod/cache/download/github.com/davecgh/go-spew/@v/v1.1.1.mod",
	"Sum": "h1:vj9j/u1bqnvCEfJOwUhtlOARqs3+rkHYY13jYWTU97c=",
	"GoModSum": "h1:J7Y8YcW2NihsgmVo/mv3lAwl/skON4iLHjSsI+c5H38="
}
{
	"Path": "github.com/gin-contrib/sse",
	"Version": "v0.1.0",
	"Time": "2019-06-02T15:02:53Z",
	"Update": {
		"Path": "github.com/gin-contrib/sse",
		"Version": "v1.1.2",
		"Time": "2026-09-05T02:39:59Z"
	},
	"Indirect": true,
	"Dir": "/root/go/pkg/mod/github.com/gin-contrib/sse@v0.1.0",
	"GoMod": "/root/go/pkg/mod/cache/download/github.com/gin-contrib/sse/@v/v0.1.0.mod",
	"GoVersion": "1.12",
	"Sum": "h1:Y/yl/+YNO8GZSjAhjMsSuLt29uWRFHdHYUb5lYOV9qE=",
	"GoModSum": "h1:RHrZQHXnP2xjPF+u1gW/2HnVO7nvIa9PG3Gm+fLHvGI="
}
`

