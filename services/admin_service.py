"""Privileged operations only. Ordinary reads and settings never use the service-role key."""
from datetime import datetime, timezone

from models.schemas import UserProfile
from services.supabase_service import create_admin_client


def _require_master(actor: UserProfile) -> None:
    if not actor.is_master:
        raise PermissionError("마스터 권한이 필요합니다.")


def list_profiles(actor: UserProfile) -> list[dict]:
    _require_master(actor)
    return create_admin_client().table("profiles").select("id,email,display_name,role,status,requested_at,approved_at").order("requested_at").execute().data


def update_account(actor: UserProfile, target_id: str, *, status: str | None = None, role: str | None = None) -> None:
    _require_master(actor)
    admin = create_admin_client()
    target = admin.table("profiles").select("id,role,status").eq("id", target_id).single().execute().data
    approved_masters = admin.table("profiles").select("id", count="exact").eq("role", "master").eq("status", "approved").execute()
    master_count = approved_masters.count or 0
    next_role, next_status = role or target["role"], status or target["status"]
    if next_role == "master" and next_status == "approved" and target["role"] != "master" and master_count >= 2:
        raise ValueError("마스터는 최대 2명까지 지정할 수 있습니다.")
    if target["role"] == "master" and target["status"] == "approved" and (next_role != "master" or next_status != "approved") and master_count <= 1:
        raise ValueError("마지막 마스터의 권한을 내리거나 비활성화할 수 없습니다.")
    changes = {k: v for k, v in {"status": status, "role": role}.items() if v is not None}
    if status == "approved":
        changes.update({"approved_by": actor.id, "approved_at": datetime.now(timezone.utc).isoformat()})
    admin.table("profiles").update(changes).eq("id", target_id).execute()
    admin.table("audit_logs").insert({"actor_user_id": actor.id, "target_user_id": target_id, "action": "account_update", "details": changes}).execute()


def delete_account(actor: UserProfile, target_id: str) -> None:
    _require_master(actor)
    admin = create_admin_client()
    target = admin.table("profiles").select("role,status").eq("id", target_id).single().execute().data
    if target["role"] == "master" and target["status"] == "approved":
        count = admin.table("profiles").select("id", count="exact").eq("role", "master").eq("status", "approved").execute().count or 0
        if count <= 1:
            raise ValueError("마지막 마스터는 삭제할 수 없습니다.")
    admin.auth.admin.delete_user(target_id)
    admin.table("audit_logs").insert({"actor_user_id": actor.id, "action": "account_delete", "details": {"target_id": target_id}}).execute()
