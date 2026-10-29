// pi-research-search: Pi extension entry. Registers research_search and web_fetch for standalone use.
// Hosts that need their own transport or credentials import createResearchTools() instead.
import { createNodeHttpClient } from './src/http.js';
import { loadConfig, loadKeys } from './src/config.js';
import { createResearchTools } from './src/tools.js';
import { withRetainedOutput } from '../../lib/retained-tool-results.mjs';

export { createResearchTools, PROMPT_GUIDELINES, PROMPT_SNIPPET, RESEARCH_SEARCH_PARAMETERS, WEB_FETCH_PARAMETERS } from './src/tools.js';
export { createNodeHttpClient } from './src/http.js';
export { createPublicFetchPolicy, createOriginPolicy, isNonPublicAddress } from './src/net-guard.js';
export { loadConfig, loadKeys, describeKeys, parseKeyFile, DEFAULT_CONFIG } from './src/config.js';
export { classifyQuery, resolveRoute, MODES, BACKENDS } from './src/router.js';
export { dedupeResults } from './src/normalize.js';

export default function piResearchSearch(pi, { env = process.env, config = loadConfig(), keys = loadKeys(), http = createNodeHttpClient(), retention = {} } = {}) {
  const { tools } = createResearchTools({ config, keys, http });
  for (const tool of tools) pi.registerTool(withRetainedOutput(tool, { ...retention, env }));
}
