import streamlit as st

from components.auth import require_approved
from services.admin_service import delete_account, list_profiles, update_account

st.set_page_config(page_title="사용자 권한 관리", page_icon="🔐", layout="wide")
actor = require_approved()
if not actor.is_master:
    st.error("마스터만 접근할 수 있습니다.")
    st.stop()

st.title("사용자 및 권한 관리")
st.caption("승인된 마스터는 최소 1명, 최대 2명까지 유지됩니다.")

try:
    profiles = list_profiles(actor)
except Exception:
    st.error("사용자 목록을 불러오지 못했습니다.")
    st.stop()

for user in profiles:
    with st.container(border=True):
        info, status_col, role_col, action_col = st.columns([3, 1.5, 1.5, 2])
        info.markdown(f"**{user.get('display_name') or '이름 미지정'}**")
        info.caption(user.get("email", ""))
        new_status = status_col.selectbox("상태", ["pending", "approved", "rejected", "disabled"],
                                          index=["pending", "approved", "rejected", "disabled"].index(user["status"]), key=f"status_{user['id']}")
        new_role = role_col.selectbox("권한", ["operator", "editor", "master"],
                                      index=["operator", "editor", "master"].index(user["role"]), key=f"role_{user['id']}")
        if action_col.button("변경 저장", key=f"save_{user['id']}", use_container_width=True):
            try:
                update_account(actor, user["id"], status=new_status, role=new_role)
                st.success("변경했습니다."); st.rerun()
            except Exception as exc:
                st.error(str(exc))
        if user["id"] != actor.id and action_col.button("계정 삭제", key=f"delete_{user['id']}", use_container_width=True):
            try:
                delete_account(actor, user["id"])
                st.success("삭제했습니다."); st.rerun()
            except Exception as exc:
                st.error(str(exc))
