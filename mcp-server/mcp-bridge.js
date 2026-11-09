#!/usr/bin/env node
/**
 * ProjexLight MCP Stdio Bridge
 *
 * Bridges MCP JSON-RPC protocol to ProjexLight HTTP API
 *
 * Usage:
 *   node mcp-bridge.js
 *
 * Environment Variables:
 *   MCP_SERVER_URL - HTTP API URL (default: http://localhost:8766)
 *   SESSION_TOKEN - Encrypted session token for authentication (required)
 *   PROJECT_ID - Project UUID for authentication (required)
 */

const http = require('http');
const https = require('https');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// CROSS-PLATFORM (macOS / Linux / Windows). Three things this gets right, each of
// which silently corrupts or breaks the result if done the obvious way:
//
//  1. execFileSync WITH AN ARGUMENT ARRAY, not execSync with a command string. A string
//     goes through a shell — cmd.exe on Windows, /bin/sh elsewhere — which quote and
//     escape differently. An array bypasses the shell entirely, so one code path works
//     on all three.
//  2. /\r?\n/ to split, not '\n'. git on Windows can emit CRLF, which leaves a trailing
//     \r on every parsed path and makes each one fail to match server-side.
//  3. core.quotePath=false. By default git C-quotes any path containing a non-ASCII
//     byte ("caf\303\251.ts"), which then matches nothing — common on macOS, where
//     filenames are routinely non-ASCII.
//
// Paths in the OUTPUT are always forward-slash: git reports repo-relative POSIX paths on
// every platform, which is exactly what the MCP expects, so no separator translation is
// needed here (and doing any would break it).
function gitOut(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

function collectGitDelta() {
  // __dirname is <project>/mcp-server; the repo root is its parent. NATIVE path — this is
  // a spawn cwd, so it must keep the platform's own separators (C:... on Windows).
  // getProjectPath()'s unix-ified form is for the MCP over HTTP, never for spawning.
  const cwd = path.dirname(__dirname);
  try {
    const changedFiles = [];
    for (const line of gitOut(['status', '--porcelain=v1', '-uno'], cwd).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      let p = line.slice(3).trim();
      if (p.includes('->')) p = p.split('->').pop().trim();   // rename: keep the new name
      if (!p) continue;
      const status = code.includes('D') ? 'deleted'
                   : code.includes('A') ? 'added'
                   : code.includes('M') ? 'modified' : 'changed';
      changedFiles.push({ path: p, status });
    }
    if (changedFiles.length === 0) return { changedFiles: [], gitDiff: '' };

    // unified=3: the server's symbol extractor reads the +/- lines and its
    // dangling-reference snippets need the surrounding context. One call, all files.
    let gitDiff = gitOut(['diff', 'HEAD', '--unified=3'], cwd);
    if (gitDiff.length > GIT_MAX_DIFF_BYTES) {
      if (DEBUG) console.error(`[MCP Bridge] gitDiff ${gitDiff.length}B exceeds cap; sending file list only`);
      gitDiff = '';
    }
    return { changedFiles, gitDiff };
  } catch (e) {
    // git missing from PATH, not a repo, or timed out. Non-fatal: the server falls back
    // to its own git and, if that also fails, says so explicitly instead of passing.
    if (DEBUG) console.error(`[MCP Bridge] collectGitDelta failed: ${e.message}`);
    return null;
  }
}


// Configuration
// MCP_SERVER_URL points to the LOCAL Docker MCP server (not the backend API)
// The Docker MCP server then connects to the backend API (api.projexlight.com)
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:8766';
const DEBUG = process.env.MCP_DEBUG === 'true';

// Authentication credentials - loaded from environment or .projexlight/config.json
let SESSION_TOKEN = process.env.SESSION_TOKEN || '';
let PROJECT_ID = process.env.PROJECT_ID || '';

// Project path for multi-project support
// Converts Windows paths to Unix format for Docker compatibility
let PROJECT_PATH = '';

function getProjectPath() {
  if (PROJECT_PATH) return PROJECT_PATH;

  // Use bridge's parent directory (project root) instead of process.cwd()
  // __dirname = mcp-server/, parent = project root — reliable regardless of CWD
  let projectDir = path.dirname(__dirname);

  // Convert Windows path to Unix format (C:\Users\name -> /c/Users/name)
  projectDir = projectDir.replace(/\\/g, '/');
  if (projectDir.length >= 2 && projectDir[1] === ':') {
    const drive = projectDir[0].toLowerCase();
    projectDir = '/' + drive + projectDir.slice(2);
  }

  PROJECT_PATH = projectDir;
  if (DEBUG) {
    console.error(`[MCP Bridge] Detected project path: ${PROJECT_PATH}`);
  }
  return PROJECT_PATH;
}

// Try to load credentials from config file (NOT the API URL - that's always localhost)
// Search order: __dirname-relative paths first (reliable regardless of CWD),
// then process.cwd()-relative paths as fallback.
function loadCredentialsFromConfig() {
  // __dirname = mcp-server/ directory where this bridge lives
  // Parent of __dirname = project root
  const bridgeDir = __dirname;
  const projectRoot = path.dirname(bridgeDir);
  const configPaths = [
    // Primary: relative to bridge location (works regardless of CWD)
    path.join(projectRoot, '.projexlight', 'config.json'),
    path.join(bridgeDir, 'config.json'),
    path.join(bridgeDir, 'mcp-config.json'),
    // Fallback: relative to CWD (legacy support)
    path.join(process.cwd(), '.projexlight', 'config.json'),
    path.join(process.cwd(), 'mcp-server', 'config.json'),
  ];

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

        // Load session token if not set via environment
        // Check both .projexlight/config.json format (sessionToken)
        // and mcp-config.json format (encryptedPlatformApiKey)
        if (!SESSION_TOKEN) {
          SESSION_TOKEN = config.sessionToken || config.encryptedPlatformApiKey || '';
        }

        // Load project ID if not set via environment
        if (config.projectId && !PROJECT_ID) {
          PROJECT_ID = config.projectId;
        }

        if (DEBUG) {
          console.error(`[MCP Bridge] Loaded credentials from ${configPath}`);
        }
        break;
      }
    } catch (e) {
      // Ignore config loading errors
    }
  }
}

loadCredentialsFromConfig();

// Tool definitions for MCP protocol
// projectPath is optional but recommended for multi-project setups
// ---------------------------------------------------------------------------
// TOOL CATALOG — fetched, not baked.
//
// The 74 tool schemas used to live in this file and were frozen into each project's
// mcp-bridge.js at CLI-export time. That put the schema in a different repo from the
// FastAPI handler that consumes the payload, and they drifted: `files` was accepted
// by both review endpoints and declared by neither, so no client could send it and
// every caller paid a ~9s corpus walk it existed to avoid.
//
// The catalog now lives in the MCP binary (src/tools/catalog.py) and is served at
// GET /api/tools with schema AND routing in one record — deliberately together,
// because a client repairing a stale bridge must add both halves; a schema without
// its endpoint produces a tool that lists fine and then fails -32601 on call.
//
// CONSEQUENCE: adding or changing a tool no longer requires re-exporting the CLI.
// The list refreshes on the next session.
//
// CACHE: last-known-good is written next to this file. If the server is unreachable
// at startup we serve the cache, because a bridge that reports zero tools is worse
// than one reporting a slightly stale list — MCP clients call tools/list ONCE per
// session, so an empty answer disables every tool until the client restarts.
// ---------------------------------------------------------------------------

const CATALOG_CACHE_PATH = path.join(__dirname, '.tools-cache.json');

// Shown only when the server is unreachable AND no cache exists — a first run with
// the container down. Advertising one actionable tool turns a confusing empty tool
// list into an instruction.
const BOOTSTRAP_TOOLS = [
  {
    name: 'projexlight_check_server_health',
    description: 'The ProjexLight MCP server is not reachable, so the tool list could not be loaded. Start it with: cd mcp-server && ./setup-all.sh (or docker compose up -d). The bridge keeps retrying and reloads the full tool set on its own once the server answers; if your CLI does not pick it up, reconnect the projexlight MCP server or restart this session.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];
const BOOTSTRAP_ENDPOINTS = {
  projexlight_check_server_health: { method: 'GET', path: '/health' }
};

let TOOLS = BOOTSTRAP_TOOLS;
let TOOL_ENDPOINTS = BOOTSTRAP_ENDPOINTS;
let CATALOG_SOURCE = 'bootstrap';

function applyCatalog(records, source) {
  if (!Array.isArray(records) || records.length === 0) return false;
  const tools = [];
  const endpoints = {};
  for (const r of records) {
    if (!r || !r.name || !r.endpoint || !r.inputSchema) continue;
    tools.push({ name: r.name, description: r.description, inputSchema: r.inputSchema });
    endpoints[r.name] = { method: r.method || 'POST', path: r.endpoint };
  }
  if (tools.length === 0) return false;
  TOOLS = tools;
  TOOL_ENDPOINTS = endpoints;
  CATALOG_SOURCE = source;
  return true;
}

function loadCatalogFromCache() {
  try {
    if (!fs.existsSync(CATALOG_CACHE_PATH)) return false;
    const doc = JSON.parse(fs.readFileSync(CATALOG_CACHE_PATH, 'utf-8'));
    return applyCatalog(doc && doc.tools, 'cache');
  } catch (e) {
    return false;
  }
}

function saveCatalogToCache(records, version) {
  try {
    fs.writeFileSync(CATALOG_CACHE_PATH,
      JSON.stringify({ version: version || '', fetchedAt: new Date().toISOString(), tools: records }, null, 2));
  } catch (e) {
    // A read-only mount must not stop the bridge starting.
  }
}

function fetchCatalog() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const url = new URL('/api/tools', MCP_SERVER_URL);
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        headers: { 'Accept': 'application/json', 'X-Bridge-Version': BRIDGE_VERSION }
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const doc = JSON.parse(body);
            if (applyCatalog(doc.tools, 'server')) {
              saveCatalogToCache(doc.tools, doc.version);
              return done(true);
            }
          } catch (e) { /* fall through to cache */ }
          done(false);
        });
      });
      // Short and hard: startup must not hang behind an unreachable server. The
      // cache covers the miss.
      req.setTimeout(5000, () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
      req.end();
    } catch (e) {
      done(false);
    }
  });
}

async function initCatalog() {
  if (await fetchCatalog()) return;
  if (loadCatalogFromCache()) {
    console.error('[MCP Bridge] Tool list served from cache (server unreachable).');
    return;
  }
  console.error('[MCP Bridge] Tool list unavailable and no cache present.');
  console.error('[MCP Bridge] Start the server; the bridge retries and reloads the tool list itself.');
}

// ---------------------------------------------------------------------------
// RECOVERY: a bridge that started while the server was down used to stay on the
// bootstrap list for the whole session. Clients call tools/list once, and every
// tools/call for a name outside that list failed "Unknown tool" -- even hours after
// the server came up. So until a catalog has come from the server itself, keep
// retrying, and when it lands tell the client its list changed (we advertise
// tools.listChanged). A cache-sourced list retries too, since it can be stale.
// ---------------------------------------------------------------------------

const CATALOG_RETRY_MS = 10000;
let catalogRetryTimer = null;
let catalogRefreshInFlight = null;
let clientInitialized = false;

function toolNamesKey() {
  return TOOLS.map((t) => t.name).sort().join(',');
}

function refreshCatalog() {
  if (!catalogRefreshInFlight) {
    const before = toolNamesKey();
    catalogRefreshInFlight = fetchCatalog().then((ok) => {
      catalogRefreshInFlight = null;
      if (!ok) return false;
      stopCatalogRetry();
      console.error('[MCP Bridge] Tool list reloaded from server: ' + TOOLS.length + ' tools.');
      if (toolNamesKey() !== before && clientInitialized) {
        console.log(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
      }
      return true;
    });
  }
  return catalogRefreshInFlight;
}

function startCatalogRetry() {
  if (catalogRetryTimer || CATALOG_SOURCE === 'server') return;
  catalogRetryTimer = setInterval(() => { refreshCatalog(); }, CATALOG_RETRY_MS);
  // Never keep the process alive on this timer alone; stdin closing ends the bridge.
  if (catalogRetryTimer.unref) catalogRetryTimer.unref();
}

function stopCatalogRetry() {
  if (catalogRetryTimer) {
    clearInterval(catalogRetryTimer);
    catalogRetryTimer = null;
  }
}


// Timeout configuration per endpoint type
const ENDPOINT_TIMEOUTS = {
  '/api/test': 180000,           // Sync API tests: 3 minutes (use async instead for large projects)
  '/api/test/start': 10000,      // Async start: 10 seconds (returns immediately)
  '/api/test/status': 10000,     // Status check: 10 seconds
  '/api/test/cancel': 10000,     // Cancel: 10 seconds
  '/api/test/clear': 10000,      // Clear result: 10 seconds
  // The review / docs endpoints run an LLM pass over every changed definition, so they
  // scale with the size of the scope rather than with network latency: a single subdir
  // (10 definitions) measures ~42s, and a full-repo review runs into minutes. Under the
  // 30s default they ALWAYS timed out, which reads to the agent as "the MCP server is
  // down" and pushes the whole workflow onto curl. 10 minutes matches the sync-test ceiling.
  '/api/instruction/review-api-definitions': 600000,
  '/api/instruction/review-ui-features': 600000,
  '/api/instruction/review-task-delta': 600000,
  '/api/instruction/generate-api-docs': 600000,
  '/api/pre-commit-regression-check': 600000,
  'default': 30000               // Default: 30 seconds
};

function getTimeoutForPath(path) {
  for (const [endpoint, timeout] of Object.entries(ENDPOINT_TIMEOUTS)) {
    if (endpoint !== 'default' && path.startsWith(endpoint)) {
      return timeout;
    }
  }
  return ENDPOINT_TIMEOUTS.default;
}

// HTTP request helper
// Bridge identity, sent as headers on every request.
//
// BRIDGE_VERSION is stamped at CLI-export time from the generator. The MCP uses it to
// tell which vintage it is talking to: one container serves several projects and
// bridges in the field currently span 10 to 74 tools, so without this the server
// cannot distinguish a stale caller from a current one, and cannot degrade for it.
const BRIDGE_VERSION = '2026.09.24-1';

// Filled in at the initialize handshake -- the only point the client discloses this.
const CLIENT_INFO = { name: '', version: '', capabilities: {} };

function makeHttpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    // CREDENTIAL gate. This whitelist decides which endpoints REQUIRE a session token —
    // nothing more. It used to gate PROJECT CONTEXT as well, and that was the defect:
    // '/api/test/start' matches none of these prefixes, so every API-testing call reached
    // the MCP carrying NO projectId and NO projectPath. The server had nothing to resolve
    // and fell back to WORKSPACE_PATH — the OWNER project. A GUEST project's test run
    // therefore executed the OWNER's api_definitions against the guest's port, produced
    // six figures of output with zero guest endpoints in it, and reported success.
    //
    // projexlight_set_context could not rescue it either: every bridge call is
    // independent and the MCP holds no per-session project state, so context has to ride
    // on each request.
    const isAuthenticatedEndpoint = (path.includes('/instruction/') || path.includes('/import/') || path.includes('/api/epics/') || path.includes('/api/features/') || path.includes('/api/scenarios/') || path.includes('/api/tasks/')) && !path.includes('/health');
    if (isAuthenticatedEndpoint && (!SESSION_TOKEN || !PROJECT_ID)) {
      reject(new Error('Missing SESSION_TOKEN or PROJECT_ID. Please ensure credentials are set via environment variables or .projexlight/config.json'));
      return;
    }

    // PROJECT CONTEXT — attached to EVERY request, whatever the endpoint or method.
    //
    // PROJECT_ID comes from this project's own .mcp.json ("env": {"PROJECT_ID": ...}) and
    // is the authoritative identity: the MCP looks it up in the shared registry
    // (~/.projexlight/registered_projects.json) and derives the container mount from it,
    // so the id alone is enough and cannot be confused between projects. projectPath is
    // sent alongside as a fallback for installs predating the registry.
    //
    // There is no endpoint for which this is wrong: every tool the bridge exposes acts on
    // one project's files, tasks or tests.
    const ctxProjectPath = (body && body.projectPath) || getProjectPath();
    const ctxProjectId = (body && body.projectId) || PROJECT_ID;

    const url = new URL(path, MCP_SERVER_URL);
    // GET carries no body, so context travels as query parameters — otherwise
    // status/read endpoints (get_api_test_status, get_context, ...) stay projectless and
    // answer for whichever project the container happens to default to.
    if (method === 'GET') {
      if (ctxProjectId && !url.searchParams.has('projectId')) url.searchParams.set('projectId', ctxProjectId);
      if (ctxProjectPath && !url.searchParams.has('projectPath')) url.searchParams.set('projectPath', ctxProjectPath);
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        // CALLER IDENTITY — headers, not body, so GET carries them too.
        //
        // The MCP could not tell which bridge vintage it was talking to, which CLI
        // tool was on the other end, or what that client declared at initialize.
        // One container serves several projects at once and bridges in the field
        // range from 10 to 74 tools, so "which caller is this" had no answer at all:
        // a bug report could not be tied to a bridge version except by reading the
        // file, and a server-side feature could not degrade for older callers
        // because it could not detect them.
        //
        // Absence is itself a signal: a request without X-Bridge-Version came from
        // the curl fallback path, not through the bridge.
        'X-Bridge-Version': BRIDGE_VERSION,
        'X-Client-Name': CLIENT_INFO.name || 'unknown',
        'X-Client-Version': CLIENT_INFO.version || 'unknown',
        // Comma-separated capability names the client declared at initialize
        // (sampling, elicitation, roots). Empty string means it declared none.
        'X-Client-Capabilities': Object.keys(CLIENT_INFO.capabilities || {}).join(',')
      }
    };

    // Get appropriate timeout for this endpoint
    const timeout = getTimeoutForPath(path);

    if (DEBUG) {
      console.error(`[MCP Bridge] ${method} ${url.href} (timeout: ${timeout}ms)`);
    }

    // Add project context to every non-GET body; credentials only where required.
    let requestBody = body || {};

    // The pre-commit gate needs git, which is unusable inside the container (see
    // collectGitDelta). Compute it here and pass it in, so the check actually runs.
    if (method !== 'GET' && path.includes('/pre-commit-regression-check')
        && !requestBody.changedFiles) {
      const delta = collectGitDelta();
      if (delta) {
        requestBody = { ...requestBody, changedFiles: delta.changedFiles, gitDiff: delta.gitDiff };
        if (DEBUG) {
          console.error(`[MCP Bridge] host git delta: ${delta.changedFiles.length} file(s), `
                        + `${delta.gitDiff.length}B diff`);
        }
      }
    }

    if (method !== 'GET') {
      requestBody = {
        ...requestBody,
        projectId: ctxProjectId,
        projectPath: ctxProjectPath,
        ...(isAuthenticatedEndpoint ? { sessionToken: SESSION_TOKEN } : {})
      };

      if (DEBUG) {
        console.error(`[MCP Bridge] Request context: projectId=${ctxProjectId} projectPath=${ctxProjectPath}`);
      }
    }

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            // FastAPI raises HTTPException as a detail field. Omitting it here
            // collapsed a precise validation message ("acceptance criteria missing
            // on 3 feature(s): ...") into a bare "HTTP 400", hiding the cause.
            const detail = Array.isArray(json.detail)
              ? json.detail.map((d) => (typeof d === 'string' ? d : JSON.stringify(d))).join('; ')
              : json.detail;
            reject(new Error(detail || json.error || json.message || `HTTP ${res.statusCode}`));
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ raw: data });
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout/1000}s. For large test suites, use projexlight_start_api_tests (async) instead.`));
    });

    if (method !== 'GET') {
      req.write(JSON.stringify(requestBody));
    }
    req.end();
  });
}

// Check if MCP server is healthy
async function checkHealth() {
  try {
    await makeHttpRequest('GET', '/health');
    return true;
  } catch (e) {
    return false;
  }
}

// Handle MCP JSON-RPC requests
async function handleRequest(request) {
  const { jsonrpc, id, method, params } = request;

  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC version' } };
  }

  try {
    switch (method) {
      case 'initialize':
        // Record who is on the other end. The client sends clientInfo and its
        // capabilities here and NOWHERE else, so this is the only chance to learn
        // them — and MCP has no way for the server to ask later.
        //
        // capabilities is what the CLIENT offers the server (sampling, elicitation,
        // roots), not what it consumes. It is the only honest answer to "can this
        // tool accept a callback", which otherwise has to be guessed per vendor and
        // per version. Stored, forwarded as a header, never acted on here.
        try {
          const ci = (params && params.clientInfo) || {};
          CLIENT_INFO.name = ci.name || 'unknown';
          CLIENT_INFO.version = ci.version || 'unknown';
          CLIENT_INFO.capabilities = (params && params.capabilities) || {};
          if (DEBUG) {
            console.error('[MCP Bridge] client: ' + CLIENT_INFO.name + ' ' + CLIENT_INFO.version
              + ' caps=' + Object.keys(CLIENT_INFO.capabilities).join(',') || '(none)');
          }
        } catch (e) {
          // Never fail the handshake over telemetry.
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: { listChanged: true }
            },
            serverInfo: {
              name: 'projexlight-mcp-bridge',
              version: '1.0.0'
            }
          }
        };

      case 'initialized':
      case 'notifications/initialized':
        // Notification, no response needed. Only from here on may we push
        // notifications/tools/list_changed to the client.
        clientInitialized = true;
        return null;

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS
          }
        };

      case 'tools/call':
        const { name, arguments: args } = params;
        let endpoint = TOOL_ENDPOINTS[name];

        // A name we do not know may just mean our list is the bootstrap or a stale
        // cache: fetch once before calling it unknown.
        if (!endpoint && CATALOG_SOURCE !== 'server') {
          await refreshCatalog();
          endpoint = TOOL_ENDPOINTS[name];
        }

        if (!endpoint) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Unknown tool: ${name}` }
          };
        }

        try {
          const result = await makeHttpRequest(endpoint.method, endpoint.path, args);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            }
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `Error calling ${name}: ${error.message}`
                }
              ],
              isError: true
            }
          };
        }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: error.message }
    };
  }
}

// Main stdio loop
async function main() {
  // Load the tool catalog BEFORE reading a single stdio line. MCP clients call
  // tools/list once, immediately, and cache the answer for the session — answering
  // early with the bootstrap list would disable every tool until restart.
  await initCatalog();
  startCatalogRetry();

  // Check server health on startup
  const healthy = await checkHealth();
  if (!healthy) {
    console.error('[MCP Bridge] Warning: ProjexLight MCP server not reachable at ' + MCP_SERVER_URL);
    console.error('[MCP Bridge] Tools: ' + TOOLS.length + ' (source: ' + CATALOG_SOURCE + ')');
    console.error('[MCP Bridge] Make sure the Docker container is running: cd mcp-server && ./setup-all.sh');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    try {
      const request = JSON.parse(line);
      const response = await handleRequest(request);

      if (response) {
        console.log(JSON.stringify(response));
      }
    } catch (error) {
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: ' + error.message }
      }));
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

main().catch(error => {
  console.error('[MCP Bridge] Fatal error:', error);
  process.exit(1);
});
