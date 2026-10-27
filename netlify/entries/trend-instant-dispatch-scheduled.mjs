// Keep the native runtime Blob SDK visible to the ESM package tracer.
import "@netlify/blobs";
import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "../functions/trend-instant-dispatch-scheduled.js";

export default withLambda(legacy.handler);
export const config = { schedule: "*/2 * * * *" };
