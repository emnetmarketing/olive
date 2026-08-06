import json
from datetime import date, timedelta

import pandas as pd
import plotly.express as px
import streamlit as st

from components.auth import require_approved, restore_auth, sign_out
from components.auth_ui import render_login
from components.styles import apply_styles
from services.analysis_service import analyze_trends, summary_metrics
from services.naver_datalab_service import search_trends
from services.naver_news_service import search_news
from services.naver_shopping_service import search_shopping
from services.results_service import recent_results, save_analysis_result
from services.settings_service import get_setting

st.set_page_config(page_title="네쇼검 트렌드 모니터", page_icon="📈", layout="wide", initial_sidebar_state="expanded")
apply_styles()

profile = restore_auth()
if not profile:
    left, center, right = st.columns([1, 1.15, 1])
    with center:
        render_login()
    st.stop()
profile = require_approved()

with st.sidebar:
    st.markdown("### NAVER TREND MONITOR")
    st.write(profile.display_name or profile.email)
    st.markdown(f'<span class="role-chip">{profile.role}</span>', unsafe_allow_html=True)
    st.page_link("app.py", label="대시보드", icon="📈")
    st.page_link("pages/2_settings.py", label="설정", icon="⚙️")
    if profile.is_master:
        st.page_link("pages/3_user_management.py", label="권한 관리", icon="🔐")
    if st.button("로그아웃", use_container_width=True):
        sign_out(); st.rerun()

st.markdown('<p class="olive-title">네쇼검 트렌드 모니터</p>', unsafe_allow_html=True)
st.markdown('<p class="olive-subtitle">소셜 급상승 키워드와 네이버 쇼핑·뉴스·DataLab 데이터를 한 화면에서 분석합니다.</p>', unsafe_allow_html=True)

try:
    settings = get_setting("dashboard")
except Exception:
    st.error("공용 설정을 불러오지 못했습니다. Supabase 연결과 RLS 설정을 확인하세요.")
    st.stop()

SAMPLE_SOCIAL = [
    {"keyword": "아크멜로 비타 세럼", "today": 12840, "yesterday": 94},
    {"keyword": "아크멜로비타세럼", "today": 10380, "yesterday": 51},
    {"keyword": "모닝글로우 쿠션", "today": 18810, "yesterday": 220},
    {"keyword": "인기 해시태그", "today": 15120, "yesterday": 9870},
    {"keyword": "루미네 바디미스트", "today": 11420, "yesterday": 40},
]

if "social_rows" not in st.session_state:
    st.session_state.social_rows = SAMPLE_SOCIAL
if "naver_products" not in st.session_state:
    st.session_state.naver_products = []

top1, top2, top3 = st.columns([1.2, 1.2, 2])
start_date = top1.date_input("수집 시작일", value=date.fromisoformat(settings["collection_start"]) if settings.get("collection_start") else date.today() - timedelta(days=7))
end_date = top2.date_input("수집 종료일", value=date.fromisoformat(settings["collection_end"]) if settings.get("collection_end") else date.today())
uploaded = top3.file_uploader("소셜 데이터 업로드", type=["csv", "xlsx", "xls"])
if uploaded:
    try:
        uploaded_frame = pd.read_csv(uploaded) if uploaded.name.lower().endswith(".csv") else pd.read_excel(uploaded)
        st.session_state.social_rows = uploaded_frame.to_dict("records")
        st.success(f"{len(uploaded_frame):,}건을 불러왔습니다.")
    except Exception:
        st.error("파일을 읽지 못했습니다. keyword, today, yesterday 열을 확인하세요.")

with st.expander("네이버 API 데이터 가져오기", expanded=True):
    query = st.text_input("검색어", placeholder="예: 비타 세럼")
    api1, api2, api3 = st.columns(3)
    if api1.button("쇼핑 검색", use_container_width=True):
        try:
            st.session_state.naver_products = search_shopping(query)
            st.success(f"쇼핑 결과 {len(st.session_state.naver_products):,}건")
        except Exception as exc: st.error(str(exc))
    if api2.button("뉴스 검색", use_container_width=True):
        try:
            st.session_state.news_items = search_news(query)
            st.success(f"뉴스 결과 {len(st.session_state.news_items):,}건")
        except Exception as exc: st.error(str(exc))
    if api3.button("DataLab 조회", use_container_width=True):
        try:
            st.session_state.datalab_items = search_trends(start_date, end_date, [{"groupName": query, "keywords": [query]}])
            st.success("DataLab 트렌드를 불러왔습니다.")
        except Exception as exc: st.error(str(exc))

try:
    result = analyze_trends(st.session_state.social_rows, st.session_state.naver_products,
                            surge_threshold=settings["surge_threshold"], yesterday_max=settings["yesterday_max"],
                            match_threshold=settings["match_threshold"])
except ValueError as exc:
    st.error(str(exc)); st.stop()

metrics = summary_metrics(result)
m1, m2, m3, m4 = st.columns(4)
m1.metric("분석 키워드", f"{metrics['keywords']:,}")
m2.metric("급상승 감지", f"{metrics['surges']:,}")
m3.metric("네이버 매칭", f"{metrics['matched']:,}")
m4.metric("오늘 언급량", f"{metrics['total_today']:,}")

chart_col, table_col = st.columns([1, 1.45])
with chart_col:
    st.subheader("키워드 언급량")
    fig = px.bar(result.head(15), x="today", y="keyword", color="is_surge", orientation="h",
                 color_discrete_map={True: "#e05252", False: "#24795e"})
    fig.update_layout(yaxis={"categoryorder": "total ascending"}, showlegend=False, margin=dict(l=0, r=0, t=10, b=0))
    st.plotly_chart(fig, use_container_width=True)
with table_col:
    st.subheader("분석 결과")
    display_columns = ["keyword", "today", "yesterday", "growth_rate", "is_surge", "brand", "matched_product", "match_score"]
    st.dataframe(result[display_columns], use_container_width=True, hide_index=True,
                 column_config={"growth_rate": st.column_config.NumberColumn("증가율", format="%.1f%%"),
                                "match_score": st.column_config.ProgressColumn("매칭", min_value=0, max_value=100)})

download_col, save_col, history_col = st.columns(3)
download_col.download_button("CSV 다운로드", result.to_csv(index=False).encode("utf-8-sig"), "naver_trend_results.csv", "text/csv", use_container_width=True)
if save_col.button("분석 결과 저장", use_container_width=True):
    try:
        payload = {"period": {"start": start_date.isoformat(), "end": end_date.isoformat()}, "metrics": metrics,
                   "rows": json.loads(result.to_json(orient="records", force_ascii=False))}
        save_analysis_result(profile, payload)
        st.success("Supabase에 저장했습니다.")
    except Exception:
        st.error("분석 결과를 저장하지 못했습니다.")
if history_col.button("최근 결과 불러오기", use_container_width=True):
    try: st.session_state.recent_results = recent_results()
    except Exception: st.error("최근 결과를 불러오지 못했습니다.")

if st.session_state.get("recent_results"):
    with st.expander("최근 저장 기록", expanded=True):
        st.dataframe(pd.DataFrame([{"저장 시각": x["created_at"], **x["result_data"].get("metrics", {})} for x in st.session_state.recent_results]), use_container_width=True)

if st.session_state.get("news_items"):
    with st.expander("뉴스 결과"):
        st.dataframe(pd.DataFrame(st.session_state.news_items)[["title_clean", "pubDate", "link"]], use_container_width=True, hide_index=True)
if st.session_state.get("datalab_items"):
    with st.expander("DataLab 결과"):
        st.json(st.session_state.datalab_items)
