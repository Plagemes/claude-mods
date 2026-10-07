import type { Sheet } from '../sheet'

export const curl: Sheet = {
  topic: 'curl',
  title: 'curl',
  aliases: [],
  summary: 'requests, headers, bodies, auth, files, timeouts, TLS',
  markdown: `## Basics
    curl <url>                                      GET and print the body
    curl -sS <url>                                  quiet, but still show errors
    curl -i <url>                                   include response headers
    curl -I <url>                                   headers only (HEAD request)
    curl -v <url>                                   verbose: request and response details
    curl -L <url>                                   follow redirects
    curl -f <url>                                   fail with exit code 22 on HTTP errors
    curl -o file <url>                              save to a file (-O keeps the remote name)
    curl -s -o /dev/null -w '%{http_code}\\n' <url>  print only the status code

## Send data
    curl -X POST <url>                              choose the method
    curl -H 'Content-Type: application/json' <url>  set a header (repeat -H)
    curl -d '{"a":1}' <url>                         send a body; POST is implied
    curl --json '{"a":1}' <url>                     JSON body with Content-Type and Accept set (curl 7.82+)
    curl -d @body.json <url>                        body from a file
    curl --data-urlencode 'q=a b' <url>             URL-encode a form value
    curl -G -d 'q=x' <url>                          send -d data as a query string
    curl -F 'file=@a.png' <url>                     multipart upload (-F name=value for plain fields)
    curl -T file <url>                              upload a file with PUT

## Auth and cookies
    curl -u user:pass <url>                       basic auth
    curl -H "Authorization: Bearer $TOKEN" <url>  bearer token (double quotes so $TOKEN expands)
    curl -b 'a=1; b=2' <url>                      send cookies
    curl -c jar.txt -b jar.txt <url>              keep cookies in a file between calls
    curl -A 'my-agent/1.0' <url>                  set the User-Agent

## Reliability
    curl --connect-timeout 5 --max-time 30 <url>  give up connecting after 5 s, the whole request after 30 s
    curl --retry 3 <url>                          retry transient failures
    curl --compressed <url>                       ask for gzip or brotli and decompress
    curl -sSf <url> | jq .                        fail loudly, pretty-print JSON

## TLS and proxies
    curl -k <url>                                         skip certificate checks (testing only)
    curl --cacert ca.pem <url>                            trust a specific CA
    curl --cert c.pem --key k.pem <url>                   client certificate
    curl -x http://proxy:8080 <url>                       use a proxy
    curl --resolve example.com:443:127.0.0.1 https://example.com  pin a hostname to an address
`,
}
