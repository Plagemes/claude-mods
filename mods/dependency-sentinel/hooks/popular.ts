/** Widely used packages per ecosystem: typosquats are names one or two edits away from these. */

const NPM = `react react-dom vue svelte preact next nuxt vite webpack webpack-cli rollup esbuild parcel typescript
ts-node tsx @babel/core @babel/preset-env eslint prettier jest vitest mocha chai sinon cypress playwright @playwright/test
puppeteer express koa fastify @nestjs/core @angular/core lodash underscore ramda moment dayjs date-fns luxon axios
node-fetch got request superagent ky chalk commander yargs inquirer ora debug dotenv cors body-parser cookie-parser
helmet morgan winston pino uuid nanoid classnames clsx styled-components tailwindcss postcss autoprefixer sass less
redux react-redux @reduxjs/toolkit zustand mobx rxjs immer zod yup joi ajv graphql @apollo/client prisma @prisma/client
mongoose sequelize typeorm knex pg mysql mysql2 sqlite3 redis ioredis socket.io ws jsonwebtoken bcrypt bcryptjs
passport nodemon concurrently cross-env rimraf glob minimist semver fs-extra mkdirp async bluebird core-js tslib
react-router react-router-dom @tanstack/react-query swr formik react-hook-form three d3 chart.js electron jquery
bootstrap husky lint-staged ts-jest @types/node @types/react openai @anthropic-ai/sdk langchain sharp multer nodemailer
cheerio jsdom marked highlight.js qs mime colors kleur picocolors execa zx hono drizzle-orm @supabase/supabase-js
firebase stripe @aws-sdk/client-s3 aws-sdk @testing-library/react msw storybook turbo lerna nx npm pnpm yarn
ms vuex pug globby enquirer xlsx prismjs @swc/core`

const PYPI = `requests numpy pandas scipy matplotlib seaborn scikit-learn tensorflow torch torchvision keras flask django
fastapi uvicorn gunicorn pydantic sqlalchemy alembic celery redis boto3 botocore pytest pytest-cov black flake8 mypy
ruff isort pylint tox setuptools wheel pip virtualenv poetry httpx aiohttp urllib3 beautifulsoup4 lxml selenium scrapy
pillow opencv-python jinja2 click typer rich tqdm pyyaml python-dotenv cryptography paramiko psycopg2 psycopg2-binary
pymongo openai anthropic transformers langchain jupyter notebook ipython sympy networkx plotly dash streamlit gradio
attrs six python-dateutil pytz certifi idna charset-normalizer packaging docker kubernetes colorama termcolor
simplejson ujson orjson marshmallow werkzeug starlette websockets grpcio protobuf pipx uv
nox psycopg httpie dask cython boto pygame wxpython`

const CRATES = `serde serde_json serde_derive tokio async-std futures rand regex clap structopt anyhow thiserror log
env_logger tracing tracing-subscriber reqwest hyper axum actix-web rocket warp diesel sqlx chrono time uuid lazy_static
once_cell itertools rayon crossbeam parking_lot bytes base64 hex sha2 ring rustls openssl toml serde_yaml bincode libc
nom syn quote proc-macro2 criterion tempfile walkdir indicatif dirs num bitflags smallvec hashbrown`

const GO = `github.com/gin-gonic/gin github.com/gorilla/mux github.com/labstack/echo/v4 github.com/spf13/cobra
github.com/spf13/viper github.com/stretchr/testify github.com/sirupsen/logrus go.uber.org/zap github.com/go-chi/chi/v5
github.com/gofiber/fiber/v2 gorm.io/gorm github.com/jackc/pgx/v5 github.com/lib/pq github.com/go-sql-driver/mysql
github.com/redis/go-redis/v9 github.com/google/uuid github.com/golang-jwt/jwt/v5 github.com/joho/godotenv
google.golang.org/grpc google.golang.org/protobuf github.com/prometheus/client_golang github.com/aws/aws-sdk-go-v2
k8s.io/client-go github.com/urfave/cli/v2 golang.org/x/sync`

const setOf = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/).filter(word => word !== ''))

export type Ecosystem = 'npm' | 'pypi' | 'crates' | 'go'

export const POPULAR: Readonly<Record<Ecosystem, ReadonlySet<string>>> = {
  npm: setOf(NPM),
  pypi: setOf(PYPI),
  crates: setOf(CRATES),
  go: setOf(GO),
}

/**
 * Edit distance counting a swap of two neighbours as one edit (optimal string
 * alignment), as typosquats often swap letters; gives up past `limit`.
 */
export const editDistance = (a: string, b: string, limit: number): number => {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let before: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, (before[j - 2] as number) + 1)
      current.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > limit) return limit + 1
    before = previous
    previous = current
  }
  return previous[b.length] as number
}

/** The popular package `name` is suspiciously close to, if any: one edit for short names, two for longer ones. */
export const nearestPopular = (ecosystem: Ecosystem, name: string): { name: string; distance: number } | undefined => {
  const popular = POPULAR[ecosystem]
  if (popular.has(name)) return undefined
  const limit = name.length <= 5 ? 1 : 2
  let best: { name: string; distance: number } | undefined
  for (const candidate of popular) {
    const distance = editDistance(name, candidate, limit)
    if (distance <= limit && (best === undefined || distance < best.distance)) best = { name: candidate, distance }
  }
  return best
}
