// Pure parts of the built-in mock: an OpenAPI 3 / Swagger 2 document turned into canned responses
// (examples first, then values made up from the schemas). No `$` here.

import { parseYaml } from './yaml'

/** One canned response the built-in server answers a method and path with. */
export type MockRoute = {
  method: string
  /** As the spec writes it, `{param}` placeholders included. */
  path: string
  status: number
  contentType: string
  /** JSON data, a text body, or undefined for no body (204, no content declared). */
  body?: unknown
}

export type MockSpec = { title: string; routes: MockRoute[] }

type Json = Record<string, unknown>

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const
const MAX_DEPTH = 6
const MAX_PROPERTIES = 40

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Follows a local `$ref` (`#/components/schemas/Pet`); undefined for a remote one or a broken pointer. */
export const resolveRef = (doc: Json, value: unknown, seen: ReadonlySet<string> = new Set()): unknown => {
  if (!isObject(value) || typeof value.$ref !== 'string') return value
  const ref = value.$ref
  if (!ref.startsWith('#/') || seen.has(ref)) return undefined
  let target: unknown = doc
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    target = isObject(target) || Array.isArray(target) ? (target as Json)[key] : undefined
  }
  return resolveRef(doc, target, new Set([...seen, ref]))
}

const STRING_FORMATS: Record<string, string> = {
  'date-time': '2024-01-01T12:00:00Z',
  date: '2024-01-01',
  time: '12:00:00',
  email: 'user@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  byte: 'U3dhZ2dlcg==',
  password: '********',
}

/** A value that fits `schema`: its example, default, first enum value, or one made up from its type. */
export const sampleOf = (doc: Json, schemaOrRef: unknown, depth = 0, seen: ReadonlySet<string> = new Set()): unknown => {
  const ref = isObject(schemaOrRef) && typeof schemaOrRef.$ref === 'string' ? schemaOrRef.$ref : undefined
  if (ref !== undefined && seen.has(ref)) return null
  const nextSeen = ref === undefined ? seen : new Set([...seen, ref])
  const schema = resolveRef(doc, schemaOrRef)
  if (!isObject(schema) || depth > MAX_DEPTH) return null
  if (schema.example !== undefined) return schema.example
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0]
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.reduce<unknown>((merged, part) => {
      const value = sampleOf(doc, part, depth + 1, nextSeen)
      return isObject(merged) && isObject(value) ? { ...merged, ...value } : (value ?? merged)
    }, {})
  }
  const choice = Array.isArray(schema.oneOf) ? schema.oneOf[0] : Array.isArray(schema.anyOf) ? schema.anyOf[0] : undefined
  if (choice !== undefined) return sampleOf(doc, choice, depth + 1, nextSeen)
  const type = Array.isArray(schema.type) ? schema.type.find(one => one !== 'null') : schema.type
  if (type === 'object' || (type === undefined && isObject(schema.properties))) {
    const properties = isObject(schema.properties) ? Object.entries(schema.properties).slice(0, MAX_PROPERTIES) : []
    const sample: Json = {}
    for (const [name, property] of properties) sample[name] = sampleOf(doc, property, depth + 1, nextSeen)
    if (properties.length === 0 && isObject(schema.additionalProperties)) sample.key = sampleOf(doc, schema.additionalProperties, depth + 1, nextSeen)
    return sample
  }
  if (type === 'array') return schema.items === undefined ? [] : [sampleOf(doc, schema.items, depth + 1, nextSeen)]
  if (type === 'integer') return typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 0
  if (type === 'number') return typeof schema.minimum === 'number' ? schema.minimum : 0
  if (type === 'boolean') return true
  if (type === 'string') return STRING_FORMATS[String(schema.format)] ?? 'string'
  return null
}

/** The response a mock gives: the lowest 2xx, else `default` (as 200), else the first one listed. */
const pickResponse = (responses: Json): { status: number; response: unknown } | undefined => {
  const codes = Object.keys(responses)
  const success = codes.filter(code => /^2(?:\d\d|XX)$/i.test(code)).sort()[0]
  const code = success ?? (codes.includes('default') ? 'default' : codes[0])
  if (code === undefined) return undefined
  const status = /^\d{3}$/.test(code) ? Number(code) : 200
  return { status, response: responses[code] }
}

const firstExample = (doc: Json, examples: unknown): unknown => {
  if (!isObject(examples)) return undefined
  const first = Object.values(examples)[0]
  const resolved = resolveRef(doc, first)
  return isObject(resolved) && 'value' in resolved ? resolved.value : undefined
}

const bodyOf = (doc: Json, operation: Json, rawResponse: unknown): { contentType: string; body?: unknown } => {
  const response = resolveRef(doc, rawResponse)
  if (!isObject(response)) return { contentType: 'application/json' }
  if (isObject(response.content)) {
    const types = Object.keys(response.content)
    const type = types.find(one => /^application\/json/i.test(one)) ?? types.find(one => /json/i.test(one)) ?? types[0]
    if (type === undefined) return { contentType: 'application/json' }
    const media = resolveRef(doc, response.content[type])
    if (!isObject(media)) return { contentType: type }
    const body = media.example ?? firstExample(doc, media.examples) ?? (media.schema === undefined ? undefined : sampleOf(doc, media.schema))
    return { contentType: type, ...(body === undefined ? {} : { body }) }
  }
  // Swagger 2: `examples` keyed by media type, `schema` beside it, `produces` on the operation or the document.
  const produces = [operation.produces, doc.produces].find(Array.isArray) as unknown[] | undefined
  const contentType = String(produces?.find(type => /json/i.test(String(type))) ?? produces?.[0] ?? 'application/json')
  const examples = isObject(response.examples) ? response.examples : undefined
  const example = examples?.[contentType] ?? (examples === undefined ? undefined : Object.values(examples)[0])
  const body = example ?? (response.schema === undefined ? undefined : sampleOf(doc, response.schema))
  return { contentType, ...(body === undefined ? {} : { body }) }
}

/** Reads a spec (YAML or JSON text) into the routes the built-in server answers. */
export const mockSpecOf = (text: string): MockSpec => {
  const doc = /^\s*\{/.test(text) ? (JSON.parse(text) as unknown) : parseYaml(text)
  if (!isObject(doc) || (!('openapi' in doc) && !('swagger' in doc))) throw new Error('this is not an OpenAPI or Swagger document')
  const base = typeof doc.basePath === 'string' ? doc.basePath.replace(/\/$/, '') : ''
  const routes: MockRoute[] = []
  for (const [path, rawItem] of Object.entries(isObject(doc.paths) ? doc.paths : {})) {
    const item = resolveRef(doc, rawItem)
    if (!isObject(item)) continue
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (!isObject(operation)) continue
      const picked = pickResponse(isObject(operation.responses) ? operation.responses : {})
      const status = picked?.status ?? 200
      const content = status === 204 || status === 304 ? { contentType: 'application/json' } : bodyOf(doc, operation, picked?.response)
      routes.push({ method: method.toUpperCase(), path: `${base}${path}`, status, ...content })
    }
  }
  const info = isObject(doc.info) ? doc.info : {}
  return { title: typeof info.title === 'string' ? info.title : 'API', routes }
}
