from datetime import date, time

import streamlit as st

from components.auth import require_approved
from components.config import secret
from services.settings_service import get_all_settings, save_setting

st.set_page_config(page_title="모니터 설정", page_icon="⚙️", layout="wide")
profile = require_approved()

st.title("모니터 설정")
st.caption("일반 설정은 Supabase에 저장되어 모든 PC에서 복원됩니다. API Secret은 Streamlit Secrets에만 보관됩니다.")

try:
    settings = get_all_settings()
except Exception:
    st.error("Supabase 설정을 불러오지 못했습니다.")
    st.stop()

dashboard = settings["dashboard"]
retention = settings["retention"]
with st.form("dashboard_settings"):
    st.subheader("분석 기준")
    c1, c2, c3 = st.columns(3)
    surge = c1.number_input("급상승 기준", min_value=1, value=int(dashboard["surge_threshold"]))
    match = c2.slider("매칭 기준 (%)", 0, 100, int(dashboard["match_threshold"]))
    yesterday = c3.number_input("전일 최대량", min_value=0, value=int(dashboard["yesterday_max"]))
    st.subheader("수집 설정")
    c1, c2 = st.columns(2)
    start = c1.date_input("수집 시작일", value=date.fromisoformat(dashboard["collection_start"]) if dashboard.get("collection_start") else date.today())
    end = c2.date_input("수집 종료일", value=date.fromisoformat(dashboard["collection_end"]) if dashboard.get("collection_end") else date.today())
    schedule_mode = st.selectbox("반복 방식", ["daily", "weekly", "monthly"], index=["daily", "weekly", "monthly"].index(dashboard["schedule_mode"]))
    schedule_time = st.time_input("수집 시간", value=time.fromisoformat(dashboard["schedule_times"][0]))
    alert_enabled = st.toggle("알림 사용", value=bool(dashboard["alert_enabled"]))
    alert_channel = st.selectbox("알림 채널", ["teams", "email", "kakao"], index=["teams", "email", "kakao"].index(dashboard["alert_channel"]))
    saved = st.form_submit_button("설정 저장", disabled=not profile.can_edit)
if saved:
    try:
        save_setting(profile, "dashboard", {**dashboard, "surge_threshold": surge, "match_threshold": match,
                     "yesterday_max": yesterday, "collection_start": start.isoformat(), "collection_end": end.isoformat(),
                     "schedule_mode": schedule_mode, "schedule_times": [schedule_time.strftime("%H:%M")],
                     "alert_enabled": alert_enabled, "alert_channel": alert_channel})
        st.success("Supabase에 설정을 저장했습니다.")
    except Exception as exc:
        st.error(str(exc))

with st.form("retention_settings"):
    st.subheader("분석 결과 보관")
    c1, c2 = st.columns(2)
    days = c1.number_input("보관 기간(일)", min_value=1, max_value=3650, value=int(retention["days"]))
    max_records = c2.number_input("최대 저장 건수", min_value=10, max_value=100000, value=int(retention["max_records"]), step=10)
    retention_saved = st.form_submit_button("보관 정책 저장", disabled=not profile.can_edit)
if retention_saved:
    try:
        save_setting(profile, "retention", {"days": days, "max_records": max_records})
        st.success("보관 정책을 저장했습니다.")
    except Exception as exc:
        st.error(str(exc))

st.subheader("서버 Secret 상태")
st.write({
    "네이버 Client ID": "설정됨" if secret("NAVER_CLIENT_ID") else "미설정",
    "네이버 Client Secret": "설정됨" if secret("NAVER_CLIENT_SECRET") else "미설정",
    "Teams Webhook": "설정됨" if secret("TEAMS_WEBHOOK_URL") else "미설정",
})
