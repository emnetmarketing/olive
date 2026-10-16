import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "../functions/today-early-signals.js";

// Native runtime configures Blob credentials; preserve the existing handler.
export default withLambda(legacy.handler);
