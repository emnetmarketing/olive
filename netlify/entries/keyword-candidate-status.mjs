import { withLambda } from "@netlify/aws-lambda-compat";
import legacy from "../functions/keyword-candidate-status.js";

// Native runtime configures Blob credentials; preserve the existing handler.
export default withLambda(legacy.handler);
