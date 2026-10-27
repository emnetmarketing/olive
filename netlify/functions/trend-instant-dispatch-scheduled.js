const { connectLambda } = require("./blob-store-compat");

// An independent scheduler tick only delivers a saved continuation. It must
// never create an analysis Job or perform source collection itself.
exports.config = { schedule: "*/2 * * * *" };
exports.handler = async (event, context = {}) => {
  connectLambda(event);
  const result = await require("./instant-dispatch").tick({ requestId: context.awsRequestId || context.requestId });
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(result) };
};
