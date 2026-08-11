const { connect, readUsers, requestAccess, updateAccess } = require("./access-management-cache");
const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  connect(event);
  try {
    if (event.httpMethod === "GET") return json(200, await readUsers());
    if (event.httpMethod !== "POST") return json(405, { error: "Only GET and POST are allowed." });
    const input = JSON.parse(event.body || "{}");
    if (input.action === "request") {
      const result = await requestAccess(input);
      return json(result.existing ? 200 : 201, { user: result.user, registry: result.registry });
    }
    return json(200, await updateAccess(input));
  } catch (error) {
    return json(/not found|required|not allowed|approved user/.test(String(error.message || "")) ? 400 : 500, { error: error.message || "Access management failed." });
  }
};
