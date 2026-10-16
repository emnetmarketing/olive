// Keep CommonJS SDK dependencies visible to Netlify's native ESM package tracer.
import "@netlify/blobs";
import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "../functions/market-discovery-list.js";

// Native runtime configures Blob credentials; preserve the existing handler.
export default withLambda(legacy.handler);
