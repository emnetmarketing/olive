import json
from datetime import datetime, timedelta, timezone

import streamlit as st
from cryptography.fernet import Fernet, InvalidToken
from extra_streamlit_components import CookieManager

from components.config import secret, secret_bool

COOKIE_NAME = "olive_auth_session"


def _cipher() -> Fernet:
    key = str(secret("SESSION_ENCRYPTION_KEY", required=True)).encode()
    return Fernet(key)


def cookie_manager() -> CookieManager:
    if "_cookie_manager" not in st.session_state:
        st.session_state._cookie_manager = CookieManager(key="olive_auth_cookie_manager")
    return st.session_state._cookie_manager


def save_tokens(access_token: str, refresh_token: str, expires_at: int | None = None) -> None:
    payload = json.dumps({"access_token": access_token, "refresh_token": refresh_token, "expires_at": expires_at}).encode()
    encrypted = _cipher().encrypt(payload).decode()
    cookie_manager().set(COOKIE_NAME, encrypted, expires_at=datetime.now(timezone.utc) + timedelta(days=14),
                         secure=secret_bool("COOKIE_SECURE", True), same_site="strict", key="set_auth_cookie")


def load_tokens() -> dict | None:
    encrypted = cookie_manager().get(COOKIE_NAME)
    if not encrypted:
        return None
    try:
        data = json.loads(_cipher().decrypt(encrypted.encode(), ttl=60 * 60 * 24 * 14))
        if not data.get("access_token") or not data.get("refresh_token"):
            return None
        return data
    except (InvalidToken, ValueError, TypeError, json.JSONDecodeError):
        clear_tokens()
        return None


def clear_tokens() -> None:
    cookie_manager().delete(COOKIE_NAME, key="delete_auth_cookie")
    for key in ("auth_tokens", "profile", "supabase_user_client"):
        st.session_state.pop(key, None)
