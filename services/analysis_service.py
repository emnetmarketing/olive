import html
import re
from difflib import SequenceMatcher
from typing import Iterable

import pandas as pd

SOCIAL_COLUMNS = {"keyword", "today", "yesterday"}


def normalize_text(value: object) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", "", str(value or ""))).lower()
    return re.sub(r"[^0-9a-z가-힣]", "", text)


def prepare_social_data(rows: Iterable[dict]) -> pd.DataFrame:
    frame = pd.DataFrame(list(rows))
    missing = SOCIAL_COLUMNS - set(frame.columns)
    if missing:
        raise ValueError("소셜 데이터 필수 열: keyword, today, yesterday")
    frame = frame.copy()
    frame["keyword"] = frame["keyword"].astype(str).str.strip()
    frame["today"] = pd.to_numeric(frame["today"], errors="coerce").fillna(0).clip(lower=0).astype(int)
    frame["yesterday"] = pd.to_numeric(frame["yesterday"], errors="coerce").fillna(0).clip(lower=0).astype(int)
    frame = frame[frame["keyword"] != ""]
    return frame


def best_product_match(keyword: str, products: Iterable[dict]) -> tuple[str, str, float]:
    normalized = normalize_text(keyword)
    best = ("", "", 0.0)
    for item in products:
        product = str(item.get("product") or item.get("title_clean") or item.get("title") or "")
        brand = str(item.get("brand") or item.get("maker") or "")
        candidate = normalize_text(f"{brand}{product}")
        if not candidate:
            continue
        containment = 1.0 if normalized in candidate or candidate in normalized else 0.0
        score = max(containment, SequenceMatcher(None, normalized, candidate).ratio()) * 100
        if score > best[2]:
            best = (brand, product, round(score, 1))
    return best


def analyze_trends(social_rows: Iterable[dict], products: Iterable[dict], *, surge_threshold: int = 10000,
                   yesterday_max: int = 500, match_threshold: int = 70) -> pd.DataFrame:
    frame = prepare_social_data(social_rows)
    frame["increase"] = frame["today"] - frame["yesterday"]
    frame["growth_rate"] = ((frame["today"] - frame["yesterday"]) / frame["yesterday"].replace(0, 1) * 100).round(1)
    frame["is_surge"] = (frame["today"] >= surge_threshold) & (frame["yesterday"] <= yesterday_max)
    matches = [best_product_match(keyword, products) for keyword in frame["keyword"]]
    frame[["brand", "matched_product", "match_score"]] = pd.DataFrame(matches, index=frame.index)
    frame["matched"] = frame["match_score"] >= match_threshold
    return frame.sort_values(["is_surge", "today"], ascending=[False, False]).reset_index(drop=True)


def summary_metrics(frame: pd.DataFrame) -> dict:
    if frame.empty:
        return {"keywords": 0, "surges": 0, "matched": 0, "total_today": 0}
    return {
        "keywords": int(len(frame)), "surges": int(frame["is_surge"].sum()),
        "matched": int(frame["matched"].sum()), "total_today": int(frame["today"].sum()),
    }
