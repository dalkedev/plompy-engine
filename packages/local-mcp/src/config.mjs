import { lstat } from 'node:fs/promises';
import { isAbsolute, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivateJson } from '../../../scripts/integrations/paths.mjs';

export const DEFAULT_CONFIG = '/var/lib/plompy-local/config/config.json';
export const integrationIds = ['web', 'playwright', 'github', 'perplexity', 'firecrawl', 'tinyfish', 'posthog', 'context7', 'openai-docs', 'camoufox', 'custom'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const path = value => typeof value === 'string' && isAbsolute(value) && resolve(value) !== '/' && !/[\x00-\x1f\x7f]/.test(value);
const require = (ok, message) => { if (!ok) throw new Error(message); };
export function validateConfig(config) {
  require(plain(config) && config.schemaVersion === 1, 'Expected Plompy Local configuration schemaVersion 1.');
  require(Object.keys(config).every(key => ['schemaVersion','server','tokenFile','artifactsDir','integrations'].includes(key)), 'Unknown local configuration field.');
  const server = config.server;
  require(plain(server), 'Missing server configuration.');
  require(['127.0.0.1', '0.0.0.0', '::1'].includes(server.host), 'Use a loopback or container listen address.');
  require(Number.isInteger(server.port) && server.port >= 1024 && server.port <= 65535, 'Use a port between 1024 and 65535.');
  require(Array.isArray(server.allowedHosts) && server.allowedHosts.length > 0 && server.allowedHosts.length <= 8 && server.allowedHosts.every(host => ['localhost', '127.0.0.1', '[::1]'].some(name => host === `${name}:${server.port}`)), 'allowedHosts must explicitly list loopback host:port values.');
  require(Array.isArray(server.allowedOrigins) && server.allowedOrigins.length <= 8 && server.allowedOrigins.every(origin => typeof origin === 'string' && ['http:', 'https:'].some(scheme => server.allowedHosts.some(host => origin === `${scheme}//${host}`))), 'Origins must be explicit loopback origins; use [] to reject all browser origins.');
  require(Object.keys(server).every(key => ['host','port','allowedHosts','allowedOrigins'].includes(key)), 'Unknown server configuration field.');
  require(path(config.tokenFile) && path(config.artifactsDir), 'Token and artifact paths must be absolute private paths.');
  const inside = (parent, child) => { const p = relative(resolve(parent), resolve(child)); return p === '' || (p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p)); };
  require(!inside(config.artifactsDir, config.tokenFile), 'Keep access tokens outside artifacts.');
  require(plain(config.integrations) && Object.keys(config.integrations).every(id => integrationIds.includes(id)), 'Unknown integration.');
  for (const [id, entry] of Object.entries(config.integrations)) {
    require(plain(entry) && typeof entry.enabled === 'boolean', `Invalid ${id} integration configuration.`);
    require(Object.keys(entry).every(key => ['enabled','auth','credentialFile','allowedTools','url'].includes(key)), `Unknown ${id} configuration field.`);
    if (entry.auth !== undefined) require(['api-key','keyless','oauth'].includes(entry.auth), 'Unknown authentication mode.');
    if (entry.credentialFile !== undefined) {
      require(path(entry.credentialFile) && !inside(config.artifactsDir, entry.credentialFile), 'Keep private credentials outside artifacts.');
      require(resolve(entry.credentialFile) !== resolve(config.tokenFile), 'Keep integration credentials separate from the local access token.');
    }
    if (entry.allowedTools !== undefined) require(Array.isArray(entry.allowedTools) && entry.allowedTools.length <= 30 && entry.allowedTools.every(name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name)) && new Set(entry.allowedTools).size === entry.allowedTools.length, 'Provide at most 30 unique explicit tool names.');
    if (entry.url !== undefined) {
      require(id === 'custom' && typeof entry.url === 'string', 'Only custom MCP accepts an operator-defined URL.');
      let url; try { url = new URL(entry.url); } catch { throw new Error('Invalid custom MCP URL.'); }
      require(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === '443'), 'Custom MCP requires HTTPS without query credentials or nonstandard ports.');
    }
  }
  return config;
}
export async function loadConfig(configPath = process.env.PLOMPY_LOCAL_CONFIG || DEFAULT_CONFIG) {
  require(path(configPath), 'Use an absolute private config path.');
  let component = resolve(configPath);
  while (component !== dirname(component)) {
    require(!(await lstat(component)).isSymbolicLink(), 'Configuration paths may not contain symlinks.');
    component = dirname(component);
  }
  const info = await lstat(dirname(configPath));
  require(info.isDirectory() && !(info.mode & 0o077) && (!process.getuid || info.uid === process.getuid()), 'Configuration directory must be owned by this user with mode 0700.');
  const source = fileURLToPath(new URL('../../../', import.meta.url));
  require(!resolve(configPath).startsWith(source), 'Store local configuration outside the public checkout.');
  const config = validateConfig(await readPrivateJson(configPath));
  require(resolve(config.tokenFile) !== resolve(configPath), 'Keep the local access token in a separate credential file.');
  for (const entry of Object.values(config.integrations)) {
    if (entry.credentialFile) require(resolve(entry.credentialFile) !== resolve(configPath), 'Keep integration credentials separate from configuration.');
  }
  return config;
}
