const blobs = require("@netlify/blobs");

// @netlify/blobs 10.7.12 connectLambda supplies edgeURL but omits
// uncachedEdgeURL. Never relabel that cached endpoint as a strong endpoint.
// API access is a supported, origin-based alternative only when the caller
// supplies API credentials explicitly; a Lambda edge token is not a PAT.
const STRONG_READ_METHODS = new Set(["get", "getMetadata", "getWithMetadata"]);
const trustedStrongContexts = new Map();
function compatibilityError(code, message) { return Object.assign(new Error(message), { code }); }
function readEnvironmentContext() {
  const encoded = globalThis.netlifyBlobsContext || process.env.NETLIFY_BLOBS_CONTEXT;
  if (typeof encoded !== "string" || !encoded) return {};
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function preserveStrongContext(context) {
  if (context.siteID && context.token && context.uncachedEdgeURL) {
    trustedStrongContexts.set(context.siteID, { token: context.token, uncachedEdgeURL: context.uncachedEdgeURL,
      primaryRegion: context.primaryRegion });
    if (trustedStrongContexts.size > 8) trustedStrongContexts.delete(trustedStrongContexts.keys().next().value);
  }
  const saved = trustedStrongContexts.get(context.siteID);
  return !context.uncachedEdgeURL && saved && saved.token === context.token
    ? { ...context, uncachedEdgeURL: saved.uncachedEdgeURL,
      ...(saved.primaryRegion ? { primaryRegion: saved.primaryRegion } : {}) } : context;
}
function connectLambda(event) {
  if (!event?.blobs) return;
  const before = preserveStrongContext(readEnvironmentContext());
  blobs.connectLambda(event);
  const after = readEnvironmentContext();
  // Preserve a genuine native strong endpoint only when it belongs to the
  // same authenticated context. Do not copy endpoints across sites or tokens.
  if (!after.uncachedEdgeURL && before.uncachedEdgeURL && before.siteID === after.siteID && before.token === after.token)
    blobs.setEnvironmentContext(preserveStrongContext({ ...after, uncachedEdgeURL: before.uncachedEdgeURL,
      ...(before.primaryRegion ? { primaryRegion: before.primaryRegion } : {}) }));
}
function normalizedOptions(input, options) {
  const normalized = typeof input === "string" ? { ...options, name: input } : { ...input };
  if (typeof normalized.name !== "string" || !normalized.name)
    throw compatibilityError("BLOBS_STORE_REQUIRED", "A named Blob store is required.");
  return normalized;
}
function explicitApiOptions(options, context) {
  const api = options.apiAccess || (process.env.NETLIFY_BLOBS_API_TOKEN ? {
    token: process.env.NETLIFY_BLOBS_API_TOKEN,
    siteID: process.env.NETLIFY_BLOBS_SITE_ID || options.siteID || context.siteID
  } : null);
  if (!api) return null;
  if (typeof api.siteID !== "string" || !api.siteID || typeof api.token !== "string" || !api.token)
    throw compatibilityError("BLOBS_API_CONFIGURATION_INVALID", "Explicit Blob API access requires both siteID and API token.");
  const targetSite = options.siteID || context.siteID;
  if (targetSite && api.siteID !== targetSite)
    throw compatibilityError("BLOBS_API_SITE_MISMATCH", "Blob API fallback must use the requested site.");
  if (api.edgeURL || api.uncachedEdgeURL)
    throw compatibilityError("BLOBS_API_CONFIGURATION_INVALID", "API access must not include edge endpoints.");
  const { apiAccess, edgeURL, uncachedEdgeURL, siteID, token, ...rest } = options;
  return { ...rest, siteID: api.siteID, token: api.token,
    ...(api.apiURL ? { apiURL: api.apiURL } : {}), consistency: "strong" };
}
function strongOptions(options, context) {
  // Supplying siteID+token explicitly is the SDK's documented context override.
  // This also keeps standalone CLI/operator API access independent of a Lambda
  // edge context that might be present in the same process.
  const explicit = Boolean(options.siteID && options.token);
  const inherited = explicit ? {} : context;
  const edgeURL = inherited.edgeURL ?? options.edgeURL;
  const uncachedEdgeURL = inherited.uncachedEdgeURL ?? options.uncachedEdgeURL;
  const { apiAccess, ...ordinary } = options;
  if (!edgeURL && !explicit) {
    const apiOptions = explicitApiOptions(options, inherited);
    if (apiOptions) return apiOptions;
  }
  if (!edgeURL || uncachedEdgeURL) return { ...ordinary,
    ...(uncachedEdgeURL ? { uncachedEdgeURL } : {}), consistency: "strong" };
  const apiOptions = explicitApiOptions(options, inherited);
  if (apiOptions) return apiOptions;
  throw compatibilityError("BLOBS_STRONG_TRANSPORT_UNAVAILABLE",
    "Strong Blob access is unavailable: the Lambda context lacks a genuine uncached endpoint. Configure supported API access or provide the native strong endpoint; eventual consistency is not a safe fallback.");
}
function getStore(input, options) {
  const configured = normalizedOptions(input, options);
  const context = preserveStrongContext(readEnvironmentContext());
  const { apiAccess, ...ordinary } = configured;
  let strongStore = null;
  const useStrong = () => strongStore ||= blobs.getStore(strongOptions(configured, context));
  if (configured.consistency === "strong") return useStrong();
  const normalStore = blobs.getStore(ordinary);
  // Existing stores also request strong consistency per operation. Route those
  // through the same fail-closed compatibility policy without weakening reads.
  return new Proxy(normalStore, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== "function") return value;
      if (STRONG_READ_METHODS.has(property)) return (key, readOptions) =>
        readOptions?.consistency === "strong"
          ? useStrong()[property](key, readOptions) : value.call(target, key, readOptions);
      return value.bind(target);
    }
  });
}

module.exports = { getStore, getCompatibleStore: getStore, connectLambda, readEnvironmentContext, strongOptions };
