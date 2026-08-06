from functools import lru_cache

from supabase import Client, ClientOptions, create_client

from components.config import supabase_anon_key, supabase_service_role_key, supabase_url


def create_anon_client() -> Client:
    """Public client. All ordinary access is constrained by the signed-in user's JWT and RLS."""
    return create_client(
        supabase_url(),
        supabase_anon_key(),
        options=ClientOptions(auto_refresh_token=False, persist_session=False),
    )


def create_user_client(access_token: str, refresh_token: str) -> Client:
    client = create_anon_client()
    client.auth.set_session(access_token, refresh_token)
    return client


@lru_cache(maxsize=1)
def create_admin_client() -> Client:
    """Service-role client. Only admin_service may import and call this function."""
    return create_client(
        supabase_url(),
        supabase_service_role_key(),
        options=ClientOptions(auto_refresh_token=False, persist_session=False),
    )
