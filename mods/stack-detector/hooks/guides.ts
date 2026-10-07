/** Every technology the detector knows, in the order its conventions are given. */
export const TECH_IDS = [
  'next',
  'react',
  'vue',
  'svelte',
  'nest',
  'express',
  'typescript',
  'node',
  'django',
  'fastapi',
  'flask',
  'python',
  'go',
  'rust',
  'rails',
  'laravel',
  'spring',
  'docker',
  'terraform',
] as const

export type TechId = (typeof TECH_IDS)[number]

export type Guide = { name: string; rules: readonly string[] }

/** Short, opinionated conventions per technology: what a careful engineer on that stack does by default. */
export const GUIDES: Record<TechId, Guide> = {
  next: {
    name: 'Next.js',
    rules: [
      'Check whether the project uses the App Router (`app/`) or the Pages Router (`pages/`) and add new routes the same way; do not mix them.',
      "In the App Router components are Server Components by default: add `'use client'` only where state, effects or browser APIs are needed.",
      'Fetch data on the server where possible; use `next/link`, `next/image` and the metadata API instead of raw tags.',
    ],
  },
  react: {
    name: 'React',
    rules: [
      'Function components and hooks only; follow the Rules of Hooks and keep effect dependency arrays complete.',
      'Derive values during render instead of syncing them with `useEffect`; keep state minimal and lift it only as far as needed.',
      'Give list items stable keys; build accessible markup (semantic elements, labels, alt text).',
    ],
  },
  vue: {
    name: 'Vue',
    rules: [
      'Match the codebase: Composition API with `<script setup>` unless it uses the Options API.',
      'Props flow down and events go up; use `computed` for derived values rather than watchers.',
      'Keep `v-for` keys stable and never put `v-if` and `v-for` on the same element.',
    ],
  },
  svelte: {
    name: 'Svelte',
    rules: [
      'Check the Svelte version: Svelte 5 uses runes (`$state`, `$derived`, `$props`, `$effect`), Svelte 4 uses `let` and `$:`; follow the one in use.',
      'In SvelteKit, load data in `+page.ts` / `+page.server.ts` and keep secrets in server-only modules.',
    ],
  },
  nest: {
    name: 'NestJS',
    rules: [
      'Follow the module structure: controller for HTTP, service for logic, module for wiring; inject dependencies through constructors.',
      'Validate input with DTO classes and the ValidationPipe; use guards for auth and filters or interceptors for cross-cutting concerns.',
    ],
  },
  express: {
    name: 'Express',
    rules: [
      'Keep route handlers thin: validate input, call a service, and map errors to status codes in one error-handling middleware.',
      'Pass async errors to `next(err)` (or the project\'s async wrapper); never leave a rejected promise unhandled.',
      'Validate request input and never build SQL or shell commands from it.',
    ],
  },
  typescript: {
    name: 'TypeScript',
    rules: [
      'Keep the code type-safe: no `any` or non-null `!` to silence errors; narrow with type guards instead.',
      'Respect the compiler options in tsconfig.json and run the type checker (e.g. `tsc --noEmit`) after changes.',
      'Use `import type` for type-only imports.',
    ],
  },
  node: {
    name: 'Node.js',
    rules: ["Use the project's package manager for installs and scripts, and never add a second lockfile."],
  },
  django: {
    name: 'Django',
    rules: [
      'Use the ORM, never raw SQL built with string formatting; keep business logic in models, managers or services rather than views.',
      'Every model change needs a migration (`makemigrations`) committed with it.',
      'Validate with forms or serializers; keep the built-in auth and CSRF protection on; read settings from the environment.',
    ],
  },
  fastapi: {
    name: 'FastAPI',
    rules: [
      'Declare request and response models with Pydantic and let FastAPI validate instead of checking by hand.',
      'Use dependencies (`Depends`) for database sessions, auth and shared logic; keep path operations thin.',
      'Use `async def` only with async libraries; blocking I/O belongs in plain `def` endpoints.',
    ],
  },
  flask: {
    name: 'Flask',
    rules: [
      'Follow the app factory and blueprints the project uses for new routes.',
      'Validate request data explicitly and return JSON errors with proper status codes; keep secrets in configuration, not code.',
    ],
  },
  python: {
    name: 'Python',
    rules: [
      "Follow PEP 8 and the formatter or linter configured in the project (ruff, black, flake8); add type hints to new functions.",
      "Use the project's environment tool (uv, poetry, pip-tools, ...) and never install packages globally; run the tests with pytest or the configured runner.",
    ],
  },
  go: {
    name: 'Go',
    rules: [
      'Format with `gofmt`/`goimports`; run `go vet ./...` and `go test ./...` after changes.',
      'Return errors instead of panicking, check every one, and wrap them with context: `fmt.Errorf("...: %w", err)`.',
      'Pass `context.Context` first through call chains; keep interfaces small and defined where they are used.',
    ],
  },
  rust: {
    name: 'Rust',
    rules: [
      'Run `cargo fmt`, `cargo clippy` and `cargo test` after changes; fix clippy warnings rather than silencing them.',
      'Propagate errors with `Result` and `?`; no `unwrap()` or `expect()` outside tests and truly impossible cases.',
      'Prefer borrowing to cloning; no new `unsafe` without a `// SAFETY:` comment that justifies it.',
    ],
  },
  rails: {
    name: 'Ruby on Rails',
    rules: [
      'Follow Rails conventions: naming, RESTful routes, and logic in models or the service objects the project uses.',
      'Every schema change is a migration; use strong parameters and ActiveRecord queries, never interpolated SQL.',
      'Run the suite the project uses (RSpec or Minitest) and RuboCop when it is configured.',
    ],
  },
  laravel: {
    name: 'Laravel',
    rules: [
      'Follow Laravel conventions: Eloquent models, form requests for validation, resource controllers and named routes.',
      'Schema changes are migrations; use Eloquent or the query builder with bindings, never interpolated SQL.',
      'Generate classes with `php artisan make:*` to match the structure, and run `php artisan test`.',
    ],
  },
  spring: {
    name: 'Spring Boot',
    rules: [
      'Use constructor injection, not field `@Autowired`; keep controllers thin and logic in `@Service` classes.',
      'Validate input with Bean Validation (`@Valid`) and handle errors in one `@ControllerAdvice`.',
      "Build and test with the project's wrapper (`./mvnw` or `./gradlew`), not a globally installed tool.",
    ],
  },
  docker: {
    name: 'Docker',
    rules: [
      'Pin base image tags, use multi-stage builds and a `.dockerignore`; run the app as a non-root user.',
      'Copy dependency manifests and install before copying the source, so layers cache.',
      'Never bake secrets into images, Dockerfiles or compose files.',
    ],
  },
  terraform: {
    name: 'Terraform',
    rules: [
      'Run `terraform fmt` and `terraform validate` after changes; never run `terraform apply` or `destroy` without the user\'s explicit go-ahead.',
      'Give variables types and descriptions; no hard-coded credentials; mark sensitive outputs `sensitive = true`.',
      'Keep to the existing module and state layout, and never edit state files by hand.',
    ],
  },
}
