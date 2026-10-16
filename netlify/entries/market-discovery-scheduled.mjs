import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "../functions/market-discovery-scheduled.js";

// Native runtime configures Blob credentials; preserve the existing handler.
export default withLambda(legacy.handler);
export const config = { schedule: "0 */6 * * *" };
