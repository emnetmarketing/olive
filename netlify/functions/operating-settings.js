const { connect, readOperatingSettings, writeOperatingSettings } = require("./operating-settings-cache");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  connect(event);
  try {
    if (event.httpMethod === "GET") return json(200, { settings: await readOperatingSettings() });
    if (event.httpMethod !== "POST") return json(405, { error: "GET 또는 POST 요청만 허용됩니다." });
    const input = JSON.parse(event.body || "{}");
    return json(200, { settings: await writeOperatingSettings(input), message: "설정이 저장되었습니다." });
  } catch (error) {
    const validationError = /기준은/.test(String(error.message || ""));
    return json(validationError ? 400 : 500, { error: error.message || "운영 설정 처리 실패" });
  }
};
