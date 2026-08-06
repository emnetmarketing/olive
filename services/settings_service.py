from copy import deepcopy
from typing import Any

from components.auth import current_user_client
from models.schemas import UserProfile

DEFAULT_DASHBOARD_SETTINGS: dict[str, Any] = {
    "surge_threshold": 10000,
    "match_threshold": 70,
    "yesterday_max": 500,
    "collection_start": None,
    "collection_end": None,
    "schedule_mode": "daily",
    "schedule_times": ["09:00"],
    "alert_enabled": False,
    "alert_channel": "teams",
}

DEFAULT_RETENTION = {"days": 90, "max_records": 1000}
ALLOWED_KEYS = {"dashboard", "retention"}


def _validate(key: str, value: dict) -> dict:
    if key == "retention":
        days = max(1, min(int(value.get("days", 90)), 3650))
        max_records = max(10, min(int(value.get("max_records", 1000)), 100000))
        return {"days": days, "max_records": max_records}
    if key == "dashboard":
        clean = {k: value.get(k, default) for k, default in DEFAULT_DASHBOARD_SETTINGS.items()}
        clean["surge_threshold"] = max(1, int(clean["surge_threshold"]))
        clean["match_threshold"] = max(0, min(int(clean["match_threshold"]), 100))
        clean["yesterday_max"] = max(0, int(clean["yesterday_max"]))
        clean["schedule_times"] = [str(v)[:5] for v in clean.get("schedule_times", []) if str(v)] or ["09:00"]
        return clean
    raise ValueError("허용되지 않은 설정입니다.")


def get_setting(key: str) -> dict:
    if key not in ALLOWED_KEYS:
        raise ValueError("허용되지 않은 설정입니다.")
    response = current_user_client().table("app_settings").select("value").eq("key", key).maybe_single().execute()
    if response.data:
        return _validate(key, response.data["value"])
    return deepcopy(DEFAULT_RETENTION if key == "retention" else DEFAULT_DASHBOARD_SETTINGS)


def save_setting(profile: UserProfile, key: str, value: dict) -> dict:
    if not profile.can_edit:
        raise PermissionError("설정 변경에는 편집 권한이 필요합니다.")
    clean = _validate(key, value)
    current_user_client().table("app_settings").upsert({
        "key": key, "value": clean, "updated_by": profile.id,
    }, on_conflict="key").execute()
    return clean


def get_all_settings() -> dict[str, dict]:
    return {key: get_setting(key) for key in ALLOWED_KEYS}
