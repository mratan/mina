// User-Agent strings for Mina's own HTTP clients.
//
// MINA_USER_AGENT is the one identity every research client sends (literature broker, supplement_get, OpenAlex Content,
// the Exa and Brave APIs): `Mina/<version> (+https://github.com/mratan/mina)`, version from the repository's package.json.
// When the user configured a contact address (RESEARCH_EMAIL), minaUserAgent({ contact }) appends `; mailto:<address>`,
// the form Crossref and OpenAlex use for their polite pools. No address is ever invented.
//
// web_fetch sends MINA_USER_AGENT too, unless config fetch.userAgent is 'browser'; see fetchUserAgent(). A measurement on
// 32 research and web pages found the Mina string never worse than the browser string, and better on some publishers.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MINA_HOMEPAGE = 'https://github.com/mratan/mina';
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function minaVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0';
  } catch { return '0'; }
}

export const MINA_VERSION = minaVersion();

/** A plausible single address (no spaces, no header-breaking characters); anything else is ignored, not sent. */
export function validContact(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  return /^[^\s@<>()";,]+@[^\s@<>()";,]+\.[^\s@<>()";,]+$/.test(v) ? v : null;
}

export function minaUserAgent({ contact = null } = {}) {
  const c = validContact(contact);
  return `Mina/${MINA_VERSION} (+${MINA_HOMEPAGE}${c ? `; mailto:${c}` : ''})`;
}

export const MINA_USER_AGENT = minaUserAgent();

/** The contact address the user configured for polite-pool requests, or null: RESEARCH_EMAIL, then NCBI_ADMIN_EMAIL (the
 *  same order the literature MCP servers use), from the environment first, then from the research key files. */
export function contactEmail({ env = process.env, keys = {} } = {}) {
  for (const name of ['RESEARCH_EMAIL', 'NCBI_ADMIN_EMAIL']) {
    const v = validContact(env?.[name]) ?? validContact(keys?.[name]);
    if (v) return v;
  }
  return null;
}

/** web_fetch's User-Agent for a fetch.userAgent setting: 'browser' → the browser string; anything else → MINA_USER_AGENT. */
export function fetchUserAgent(setting) {
  return setting === 'browser' ? BROWSER_USER_AGENT : MINA_USER_AGENT;
}
