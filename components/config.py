import os
from typing import Any

def secret(name: str, default: Any = None, required: bool = False) -> Any:
    value = os.getenv(name)
    if value is None:
        try:
            import streamlit as st
            value = st.secrets.get(name, default)
        except (FileNotFoundError, KeyError, ImportError):
            value = default
    if required and not value:
        raise RuntimeError(f"필수 배포 설정이 없습니다: {name}")
    return value


def supabase_url() -> str:
    return str(secret("SUPABASE_URL", required=True))


def supabase_anon_key() -> str:
    return str(secret("SUPABASE_ANON_KEY", required=True))


def supabase_service_role_key() -> str:
    return str(secret("SUPABASE_SERVICE_ROLE_KEY", required=True))


def secret_bool(name: str, default: bool = False) -> bool:
    value = secret(name, default)
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}
