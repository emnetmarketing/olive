from typing import Any

import httpx

from components.config import secret

BASE_URL = "https://openapi.naver.com"
TIMEOUT_SECONDS = 20


class NaverAPIError(RuntimeError):
    pass


def auth_headers() -> dict[str, str]:
    client_id = str(secret("NAVER_CLIENT_ID", required=True))
    client_secret = str(secret("NAVER_CLIENT_SECRET", required=True))
    return {"X-Naver-Client-Id": client_id, "X-Naver-Client-Secret": client_secret}


def request_json(method: str, path: str, *, params: dict | None = None, payload: dict | None = None) -> dict[str, Any]:
    if not path.startswith("/") or "://" in path:
        raise ValueError("허용되지 않은 네이버 API 경로입니다.")
    try:
        response = httpx.request(method, f"{BASE_URL}{path}", headers=auth_headers(), params=params,
                                 json=payload, timeout=TIMEOUT_SECONDS)
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise NaverAPIError("네이버 API 응답 형식이 올바르지 않습니다.")
        return data
    except httpx.TimeoutException as exc:
        raise NaverAPIError("네이버 API 요청 시간이 초과되었습니다.") from exc
    except httpx.HTTPError as exc:
        status = getattr(exc.response, "status_code", None)
        suffix = f" (HTTP {status})" if status else ""
        raise NaverAPIError(f"네이버 API 요청에 실패했습니다{suffix}.") from exc
    except ValueError as exc:
        raise NaverAPIError("네이버 API JSON 응답을 해석하지 못했습니다.") from exc
