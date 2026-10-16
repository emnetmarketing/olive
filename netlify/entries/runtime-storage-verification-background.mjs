// Keep CommonJS SDK dependencies visible to Netlify's native ESM package tracer.
import "@netlify/blobs";
import "exceljs";
import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "../functions/runtime-storage-verification-background.js";

// Native runtime configures Blob credentials; preserve the existing handler.
// Legacy background handlers complete (or checkpoint) without an HTTP result.
export default withLambda(async (event, context) =>
  (await legacy.handler(event, context)) ?? { statusCode: 204 });
export const config = { background: true };
