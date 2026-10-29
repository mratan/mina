# Attribution

`index.js` and `src/` are a small fork of `@bytetrue/pi-web-search` version 0.5.1, published on npm under the MIT
License (`"license": "MIT"` in its `package.json`). Author: byte (ByteTrue).
Upstream repository: https://github.com/ByteTrue/pi-package-mono (`packages/pi-web-search`).
The published tarball contains no LICENSE file and the repository has none at its root, so `LICENSE` here reproduces
the standard MIT text for the declared license.

The upstream source says that its HTML extraction, URL guard and several provider clients were ported from
`@juicesharp/rpiv-web-tools` (npm; github.com/juicesharp/rpiv-mono), MIT, Copyright (c) 2026 juicesharp. `LICENSE`
includes that copyright line.

`pristine/` holds the unmodified upstream files from `npm pack @bytetrue/pi-web-search@0.5.1`
(`src/`, `package.json`, `README.md`). `pristine/SOURCE.sha256` lists the tarball hash and every file hash.
npm `dist.shasum` of the tarball: `75e86f260befc26508262a752a3f0cb3412a5bce`.

## What came from upstream

| Fork file | Upstream origin | Kept |
|---|---|---|
| `src/net-guard.js` | `src/html.ts`, "URL guard (SSRF)" | BlockList ranges, IPv6 word parsing, NAT64/IPv4-mapped handling, hostname normalization |
| `src/html.js` | `src/html.ts`, HTML-to-text | Tag stripping, block-to-newline, entity decoding, title extraction |
| `src/http.js` | `src/html.ts` `fetchUrlOrThrow`, `src/response-body.ts` | Manual redirect loop (max 5, re-validated per hop), byte cap |
| `src/providers/exa.js` | `src/providers/exa.ts`, `src/providers/exa-free.ts` | Keyless Exa MCP client (initialize, notify, tools/call, SSE parsing, result-block parsing) |
| `src/providers/brave.js` | `src/providers/brave.ts` | Endpoint and header |
| `src/providers/searxng.js` | `src/providers/searxng.ts` | JSON endpoint use |
| `src/tools.js` `web_fetch` | `src/tools.ts` `registerWebFetchTool` | Tool name, `raw` option, header lines, browser user agent |

## Why this is a fork and not a patch

No patch from `pristine/` to the fork is provided, because the fork is a restructure rather than an edit. A diff
would replace every line. The table above maps each fork file to its origin instead. The reasons for the restructure:

1. **Fallback chain, not routing.** Upstream `providers` is a failure fallback chain (`searchWithProvider` tries each
   provider in order until one succeeds). Mina needs explicit, intent-driven backend selection and a
   multi-backend `verify` path. The fork replaces the chain with `src/router.js` modes and parallel per-backend calls.
2. **Transport.** Upstream uses `undici` `fetch` and a process-wide proxy dispatcher. The host supervisor replaces
   `globalThis.fetch` with a redirect-erroring, tracing wrapper, and `web_fetch` must follow redirects manually and pin
   each connection to a vetted IP. The fork has an injectable `http` client (`src/http.js`, node:http/https, GET/POST
   only, per-hop policy hook, optional `trace`) and no `undici` dependency.
3. **Factory.** Upstream registers tools directly on `pi` and reads global config. The fork builds plain tool
   definitions in `createResearchTools({ config, http, keys, now })`; `index.js` is a thin standalone registration.
4. **No build step and no runtime dependencies.** The fork is plain ESM JavaScript. Tool schemas are plain JSON Schema,
   which Pi 0.99.2 validates through its non-TypeBox path, so `typebox` is not imported.
5. **Dropped.** The `/web` interactive config command, config-file writing, the proxy dispatcher, temp-file spill of
   long pages (the fork uses `start_char` continuation), and the Bing, Bocha, Tavily, Jina and Firecrawl providers.
   Tavily is excluded by design. The others are outside the Exa, SearXNG and Brave hierarchy.
6. **Tightened SSRF guard.** 198.18.0.0/15 is blocked (upstream allowed it for fake-ip TUN proxies). 6to4 (2002::/16)
   and Teredo stay blocked rather than unwrapped. `.internal` and `.local` names are refused. Every resolved address
   must be public, and the connection goes to the vetted address. Only an explicit `fetch.allowHosts` entry overrides it.

Backward compatibility: keys and the SearXNG URL are still read from upstream's config file
(`<agent dir>/pi-pkg-cfg/pi-web-search/config.json`, `apiKeys.exa`, `apiKeys.brave`, `baseUrls.searxng`) as the
lowest-priority source. Environment variables keep upstream's names: `EXA_API_KEY`, `BRAVE_SEARCH_API_KEY`, `SEARXNG_URL`.
