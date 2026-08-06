import re

from services.naver_common import request_json


def search_shopping(query: str, display: int = 100, start: int = 1, sort: str = "sim") -> list[dict]:
    query = query.strip()
    if not query:
        raise ValueError("쇼핑 검색어를 입력하세요.")
    data = request_json("GET", "/v1/search/shop.json", params={
        "query": query, "display": max(1, min(display, 100)), "start": max(1, min(start, 1000)), "sort": sort,
    })
    return [{**item, "title_clean": re.sub(r"<[^>]+>", "", str(item.get("title", "")))} for item in data.get("items", [])]
