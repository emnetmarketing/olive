from datetime import date
from typing import Iterable

from services.naver_common import request_json


def search_trends(start_date: date, end_date: date, keyword_groups: Iterable[dict], time_unit: str = "date",
                  device: str | None = None, gender: str | None = None, ages: list[str] | None = None) -> list[dict]:
    groups = list(keyword_groups)
    if not groups or len(groups) > 5:
        raise ValueError("DataLab 키워드 그룹은 1~5개여야 합니다.")
    payload = {
        "startDate": start_date.isoformat(), "endDate": end_date.isoformat(), "timeUnit": time_unit,
        "keywordGroups": groups,
    }
    if device: payload["device"] = device
    if gender: payload["gender"] = gender
    if ages: payload["ages"] = ages
    return request_json("POST", "/v1/datalab/search", payload=payload).get("results", [])
