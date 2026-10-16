import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "../functions/trend-analysis-current.js";

// Native runtime configures Blob credentials; preserve the existing handler.
export default withLambda(legacy.handler);
