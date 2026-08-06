from typing import Any

from components.auth import current_user_client
from models.schemas import UserProfile
from services.settings_service import get_setting


def save_analysis_result(profile: UserProfile, result_data: dict[str, Any]) -> None:
    if not profile.approved:
        raise PermissionError("승인된 사용자만 분석 결과를 저장할 수 있습니다.")
    client = current_user_client()
    client.table("analysis_results").insert({"result_data": result_data, "created_by": profile.id}).execute()
    client.rpc("cleanup_analysis_results").execute()


def recent_results(limit: int = 20) -> list[dict]:
    retention = get_setting("retention")
    safe_limit = max(1, min(int(limit), min(retention["max_records"], 200)))
    return current_user_client().table("analysis_results").select("id,run_id,result_data,created_at,created_by").order("created_at", desc=True).limit(safe_limit).execute().data
