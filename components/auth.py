from typing import Any

import streamlit as st

from components.session import clear_tokens, load_tokens, save_tokens
from models.schemas import UserProfile
from services.supabase_service import create_anon_client, create_user_client


def _session_tokens(session: Any) -> dict:
    return {
        "access_token": session.access_token,
        "refresh_token": session.refresh_token,
        "expires_at": getattr(session, "expires_at", None),
    }


def sign_up(email: str, password: str, display_name: str) -> str:
    response = create_anon_client().auth.sign_up({
        "email": email.strip().lower(), "password": password,
        "options": {"data": {"display_name": display_name.strip()}},
    })
    if response.session:
        tokens = _session_tokens(response.session)
        save_tokens(**tokens)
    return "가입 신청이 접수되었습니다. 이메일 인증 후 마스터 승인을 기다려주세요."


def sign_in(email: str, password: str) -> UserProfile:
    response = create_anon_client().auth.sign_in_with_password({"email": email.strip().lower(), "password": password})
    tokens = _session_tokens(response.session)
    save_tokens(**tokens)
    st.session_state.auth_tokens = tokens
    return restore_auth(force=True)


def restore_auth(force: bool = False) -> UserProfile | None:
    if not force and isinstance(st.session_state.get("profile"), UserProfile):
        return st.session_state.profile
    tokens = st.session_state.get("auth_tokens") or load_tokens()
    if not tokens:
        return None
    try:
        client = create_user_client(tokens["access_token"], tokens["refresh_token"])
        session = client.auth.get_session()
        if session:
            fresh = _session_tokens(session)
            if fresh != tokens:
                save_tokens(**fresh)
                tokens = fresh
        user = client.auth.get_user().user
        record = client.table("profiles").select("id,email,display_name,role,status").eq("id", user.id).single().execute().data
        profile = UserProfile.from_record(record)
        st.session_state.auth_tokens = tokens
        st.session_state.supabase_user_client = client
        st.session_state.profile = profile
        return profile
    except Exception:
        clear_tokens()
        return None


def current_user_client():
    profile = restore_auth()
    if not profile:
        raise PermissionError("로그인이 필요합니다.")
    return st.session_state.supabase_user_client


def sign_out() -> None:
    client = st.session_state.get("supabase_user_client")
    if client:
        try:
            client.auth.sign_out()
        except Exception:
            pass
    clear_tokens()


def require_approved() -> UserProfile:
    profile = restore_auth()
    if not profile:
        st.error("로그인이 필요합니다.")
        st.stop()
    if not profile.approved:
        messages = {"pending": "승인 대기 중입니다.", "rejected": "접근 신청이 거절되었습니다.", "disabled": "비활성화된 계정입니다."}
        st.warning(messages.get(profile.status, "이 계정으로 접근할 수 없습니다."))
        if st.button("로그아웃"):
            sign_out(); st.rerun()
        st.stop()
    return profile
