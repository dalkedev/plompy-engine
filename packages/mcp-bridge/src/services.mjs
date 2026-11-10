// Fixed vendor destinations, not an arbitrary credential-forwarding proxy.
export const remoteServices = Object.freeze({
  perplexity: Object.freeze({
    label: "Perplexity",
    authModes: Object.freeze(["oauth", "api-key"]),
    defaultAuth: "oauth",
    endpoints: Object.freeze({
      oauth: "https://api.perplexity.ai/mcp",
      "api-key": "https://api.perplexity.ai/mcp",
    }),
    header: "Authorization",
    prefix: "Bearer ",
  }),
  firecrawl: Object.freeze({
    label: "Firecrawl",
    authModes: Object.freeze(["oauth", "api-key", "keyless"]),
    defaultAuth: "oauth",
    endpoints: Object.freeze({
      oauth: "https://mcp.firecrawl.dev/v2/mcp-oauth",
      "api-key": "https://mcp.firecrawl.dev/v2/mcp",
      keyless: "https://mcp.firecrawl.dev/v2/mcp",
    }),
    header: "Authorization",
    prefix: "Bearer ",
  }),
  tinyfish: Object.freeze({
    label: "TinyFish",
    authModes: Object.freeze(["oauth", "api-key"]),
    defaultAuth: "oauth",
    endpoints: Object.freeze({
      oauth: "https://agent.tinyfish.ai/mcp",
      "api-key": "https://agent.tinyfish.ai/mcp",
    }),
    header: "X-API-Key",
    prefix: "",
  }),
  posthog: Object.freeze({
    label: "PostHog",
    authModes: Object.freeze(["oauth", "api-key"]),
    defaultAuth: "oauth",
    endpoints: Object.freeze({
      oauth: "https://mcp.posthog.com/mcp?readonly=true",
      "api-key": "https://mcp.posthog.com/mcp",
    }),
    header: "Authorization",
    prefix: "Bearer ",
    headers: Object.freeze({ "x-posthog-read-only": "true" }),
  }),
});

export const remoteServiceIds = Object.freeze(Object.keys(remoteServices));

export function serviceDefinition(id) {
  if (!Object.hasOwn(remoteServices, id))
    throw new Error("Unknown managed MCP service.");
  return remoteServices[id];
}

export function isManagedReadonlyUrl(value) {
  return value === remoteServices.posthog.endpoints.oauth;
}
