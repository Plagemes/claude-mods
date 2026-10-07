// Pure parts of the server: the built-in mock's Node.js script (run with `node -e`, its routes on
// stdin) and readers for the lines it and Prism print. No `$` here.

/** What a line of server output says. */
export type ServerEvent =
  | { type: 'ready'; url?: string }
  | { type: 'request'; method: string; path: string; status?: number; ms?: number }
  | { type: 'status'; status: number }
  | { type: 'route'; method: string; path: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'log'; text: string }

/**
 * The built-in mock server. It reads `{ port, host, routes }` as JSON on stdin, answers each route
 * with its canned response (path parameters match any segment), 405 for a known path with another
 * method, 404 otherwise, with permissive CORS, and prints one JSON line per event.
 */
export const BUILTIN_SERVER = String.raw`'use strict';
const http = require('http');
let input = '';
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
const escape = text => text.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
const compile = route => {
  const source = route.path.split(/(\{[^}]+\})/).map(piece => (/^\{[^}]+\}$/.test(piece) ? '[^/]+' : escape(piece))).join('');
  return Object.assign({}, route, { params: (route.path.match(/\{[^}]+\}/g) || []).length, pattern: new RegExp('^' + source + '/?$') });
};
const start = config => {
  const routes = config.routes.map(compile).sort((a, b) => a.params - b.params);
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
    'access-control-expose-headers': '*',
  };
  const server = http.createServer((request, response) => {
    const started = Date.now();
    request.on('data', () => {});
    request.on('end', () => {
      const url = new URL(request.url || '/', 'http://localhost');
      const method = (request.method || 'GET').toUpperCase();
      const matching = routes.filter(route => route.pattern.test(url.pathname));
      const route = matching.find(one => one.method === method) || (method === 'HEAD' ? matching.find(one => one.method === 'GET') : undefined);
      let status = 404;
      let type = 'application/json';
      let body = { error: 'No mock for this path in the spec', paths: Array.from(new Set(routes.map(one => one.path))) };
      if (route) {
        status = route.status;
        type = route.contentType;
        body = route.body;
      } else if (matching.length > 0 && method === 'OPTIONS') {
        status = 204;
        body = undefined;
      } else if (matching.length > 0) {
        status = 405;
        body = { error: 'The spec does not allow this method here', allowed: matching.map(one => one.method) };
      }
      const headers = Object.assign({}, cors);
      let payload;
      if (body !== undefined) {
        headers['content-type'] = type;
        payload = typeof body === 'string' && !/json/i.test(type) ? body : JSON.stringify(body, null, 2);
      }
      response.writeHead(status, headers);
      response.end(method === 'HEAD' ? undefined : payload);
      emit({ type: 'request', method, path: url.pathname + url.search, status, ms: Date.now() - started });
    });
  });
  server.on('error', error => {
    emit({ type: 'error', code: error.code, message: error.message });
    process.exit(1);
  });
  server.listen(config.port, config.host, () => emit({ type: 'ready', url: 'http://' + (config.host === '127.0.0.1' ? 'localhost' : config.host) + ':' + config.port }));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  try {
    start(JSON.parse(input));
  } catch (error) {
    emit({ type: 'error', message: 'bad configuration: ' + error.message });
    process.exit(2);
  }
});
`

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

/** A line the built-in server printed: one JSON event, or plain text (a Node.js error, say). */
export const parseBuiltinLine = (line: string): ServerEvent | undefined => {
  const text = line.trim()
  if (text === '') return undefined
  try {
    const event = JSON.parse(text) as Record<string, unknown>
    if (event.type === 'ready') return { type: 'ready', ...(typeof event.url === 'string' ? { url: event.url } : {}) }
    if (event.type === 'request' && typeof event.method === 'string' && typeof event.path === 'string') {
      return {
        type: 'request',
        method: event.method,
        path: event.path,
        ...(typeof event.status === 'number' ? { status: event.status } : {}),
        ...(typeof event.ms === 'number' ? { ms: event.ms } : {}),
      }
    }
    if (event.type === 'error') return { type: 'error', message: String(event.message ?? 'unknown error'), ...(typeof event.code === 'string' ? { code: event.code } : {}) }
  } catch {
    // Not one of the server's events.
  }
  return { type: 'log', text }
}

/** A line Prism printed: its route listing, the listening line, requests, response codes and errors. */
export const parsePrismLine = (line: string): ServerEvent | undefined => {
  const text = line.replace(ANSI, '').trim()
  if (text === '') return undefined
  const listening = /Prism is listening on (\S+)/.exec(text)
  if (listening !== null) return { type: 'ready', url: (listening[1] as string).replace('127.0.0.1', 'localhost') }
  const request = /\[HTTP SERVER\]\s+(\w+)\s+(\S+)\s+.*Request received/i.exec(text)
  if (request !== null) return { type: 'request', method: (request[1] as string).toUpperCase(), path: request[2] as string }
  const status = /status code (\d{3})/i.exec(text)
  if (status !== null) return { type: 'status', status: Number(status[1]) }
  if (/NO_PATH_MATCHED/.test(text)) return { type: 'status', status: 404 }
  if (/NO_METHOD_MATCHED/.test(text)) return { type: 'status', status: 405 }
  const route = /\[CLI\].*?\binfo\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|TRACE)\s+https?:\/\/[^/\s]+(\/\S*)/.exec(text)
  if (route !== null) return { type: 'route', method: route[1] as string, path: route[2] as string }
  if (/✖|\berror\b/i.test(text)) return { type: 'error', message: text.replace(/^\[[^\]]*\]\s*›?\s*/, '') }
  return { type: 'log', text }
}

/** `/mock [spec] [port]`: a 2-5 digit word is the port, any other word the spec. */
export const parseMockArgs = (args: string): { spec?: string; port?: number } | { error: string } => {
  let spec: string | undefined
  let port: number | undefined
  for (const word of args.split(/\s+/).filter(Boolean)) {
    if (/^\d{2,5}$/.test(word)) {
      const value = Number(word)
      if (value < 1 || value > 65535) return { error: `${word} is not a port.` }
      port = value
    } else if (spec === undefined) {
      spec = word.replace(/^['"]|['"]$/g, '')
    } else {
      return { error: `one spec at a time ("${spec}" and "${word}").` }
    }
  }
  return { ...(spec === undefined ? {} : { spec }), ...(port === undefined ? {} : { port }) }
}
