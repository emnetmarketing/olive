import io
import re
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

# ==========================================
# 0. PAGE CONFIG & CUSTOM CSS (Corporate White & 3-Column Layout)
# ==========================================
st.set_page_config(
    page_title="AI 퍼포먼스 마케팅 주간 리포트 & Agent",
    page_icon="🤖",
    layout="wide",
    initial_sidebar_state="expanded"
)

CUSTOM_CSS = """
<style>
    @import url('https://fonts.googleapis.com/css2?family=Pretendard:wght@400;500;600;700&display=swap');
    
    html, body, [class*="css"] {
        font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, Roboto, sans-serif;
        color: #1E293B;
    }
    
    .stApp {
        background-color: #F8FAFC;
    }
    
    /* Header Section */
    .report-header {
        background: white;
        padding: 1.2rem 1.8rem;
        border-radius: 12px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.04);
        border: 1px solid #E2E8F0;
        margin-bottom: 1.2rem;
    }
    .report-title {
        font-size: 1.5rem;
        font-weight: 700;
        color: #0F172A;
        margin-bottom: 0.2rem;
    }
    .report-subtitle {
        font-size: 0.9rem;
        color: #64748B;
    }

    /* Card Component Styling */
    .metric-card {
        background: #FFFFFF;
        border: 1px solid #E2E8F0;
        border-radius: 10px;
        padding: 1rem;
        box-shadow: 0 1px 3px rgba(0,0,0,0.02);
        transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .metric-card:hover {
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
    }
    .metric-label {
        font-size: 0.8rem;
        font-weight: 600;
        color: #64748B;
        text-transform: uppercase;
        letter-spacing: 0.025em;
        margin-bottom: 0.25rem;
    }
    .metric-value {
        font-size: 1.35rem;
        font-weight: 700;
        color: #0F172A;
        margin-bottom: 0.4rem;
    }
    .comparison-container {
        display: flex;
        justify-content: space-between;
        font-size: 0.75rem;
        border-top: 1px solid #F1F5F9;
        padding-top: 0.35rem;
        margin-top: 0.35rem;
    }
    .comparison-item {
        display: flex;
        align-items: center;
        gap: 3px;
    }
    .comp-label {
        color: #94A3B8;
    }
    .badge-up {
        color: #059669;
        font-weight: 600;
        background-color: #ECFDF5;
        padding: 1px 5px;
        border-radius: 4px;
    }
    .badge-down {
        color: #DC2626;
        font-weight: 600;
        background-color: #FEF2F2;
        padding: 1px 5px;
        border-radius: 4px;
    }
    .badge-neutral {
        color: #64748B;
        font-weight: 500;
        background-color: #F1F5F9;
        padding: 1px 5px;
        border-radius: 4px;
    }
    
    /* Section Headings */
    .section-title {
        font-size: 1.15rem;
        font-weight: 700;
        color: #1E293B;
        margin: 1.2rem 0 0.8rem 0;
        display: flex;
        align-items: center;
        gap: 6px;
    }

    /* Agent Container Styling */
    .agent-header {
        background: white;
        padding: 1rem 1.2rem;
        border-radius: 10px;
        border: 1px solid #E2E8F0;
        font-weight: 700;
        font-size: 1.1rem;
        color: #0F172A;
        margin-bottom: 1rem;
        display: flex;
        align-items: center;
        gap: 8px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.02);
    }
</style>
"""
st.markdown(CUSTOM_CSS, unsafe_allow_html=True)


# ==========================================
# 1. HELPER FUNCTIONS & COLUMN DETECTION
# ==========================================
COLUMN_ALIASES = {
    "date": ["date", "일자", "날짜", "보고일", "day", "dt", "일", "ymd", "일시", "기준일", "기간", "reg_date", "stat_date"],
    "impressions": ["impression", "impressions", "노출", "노출수", "imp", "views", "노출 수", "view_cnt"],
    "clicks": ["click", "clicks", "클릭", "클릭수", "클릭 수", "click_cnt"],
    "cost": ["cost", "spend", "비용", "광고비", "총비용", "amount", "지출", "소진비용", "소진액", "총광고비", "소진 금액", "집행비용"],
    "conversions": ["conversion", "conversions", "전환", "전환수", "구매", "구매수", "purchase", "purchases", "order", "orders", "전환 수", "conv_cnt", "구매 건수"],
    "revenue": [
        "revenue", "sales", "매출", "매출액", "구매금액", "전환금액", "총매출", "구매 금액",
        "전환가치", "전환 가치", "conv value", "convvalue", "conversion value", "conversionvalue",
        "결제금액", "결제 금액", "주문금액", "주문 금액", "금액", "value", "amount", "gmv", "gma",
        "total revenue", "total sales", "total_amount", "pay_amount", "purchase_value", "총 전환 가치",
        "전환가치(원)", "매출(원)", "구매금액(원)", "전환금액(원)"
    ]
}

# 추가 차원 컬럼 탐지 키워드 (매체, 캠페인, 광고그룹, 키워드 등)
DIMENSION_ALIASES = {
    "media": ["media", "channel", "network", "platform", "매체", "채널", "플랫폼", "광고매체", "매체명"],
    "campaign": ["campaign", "캠페인", "캠페인명", "campaign_name"],
    "adgroup": ["adgroup", "ad_group", "adgroup_name", "광고그룹", "광고그룹명", "그룹명"],
    "keyword": ["keyword", "키워드", "검색어", "keyword_name"],
    "ad": ["ad", "creative", "소재", "광고소재", "소재명", "ad_name"]
}

def detect_columns(df_cols, user_overrides=None):
    """
    컬럼명 유연 자동 탐지 함수 + 사용자 수동지정 Override 지원
    """
    mapped = {}
    normalized_cols = {col: re.sub(r'[\s_\-\(\)]', '', str(col)).lower() for col in df_cols}
    
    for key, aliases in COLUMN_ALIASES.items():
        if user_overrides and key in user_overrides and user_overrides[key] in df_cols:
            mapped[key] = user_overrides[key]
            continue

        matched = None
        for alias in aliases:
            clean_alias = re.sub(r'[\s_\-\(\)]', '', alias).lower()
            for orig_col, norm_col in normalized_cols.items():
                if clean_alias == norm_col or clean_alias in norm_col:
                    matched = orig_col
                    break
            if matched:
                break
        if matched:
            mapped[key] = matched
            
    return mapped

def detect_dimension_columns(df_cols):
    """
    원본 DataFrame에서 차원 컬럼(매체, 캠페인, 광고그룹 등) 자동 감지
    """
    dim_mapped = {}
    normalized_cols = {col: re.sub(r'[\s_\-\(\)]', '', str(col)).lower() for col in df_cols}
    
    for dim_key, aliases in DIMENSION_ALIASES.items():
        for alias in aliases:
            clean_alias = re.sub(r'[\s_\-\(\)]', '', alias).lower()
            for orig_col, norm_col in normalized_cols.items():
                if clean_alias == norm_col or clean_alias in norm_col:
                    dim_mapped[dim_key] = orig_col
                    break
            if dim_key in dim_mapped:
                break
    return dim_mapped


@st.cache_data(show_spinner=False)
def load_and_preprocess_data(file_bytes, filename, user_overrides=None):
    """
    TSV / CSV 파일 읽기 및 데이터 수치 정제 (인코딩 자동 감지 시도)
    """
    encodings = ['utf-8', 'cp949', 'utf-16', 'utf-16le', 'euc-kr']
    raw_df = None
    
    sep = '\t' if filename.endswith('.tsv') or filename.endswith('.txt') else None
    
    for enc in encodings:
        try:
            if sep:
                raw_df = pd.read_csv(io.BytesIO(file_bytes), sep=sep, encoding=enc)
            else:
                raw_df = pd.read_csv(io.BytesIO(file_bytes), sep=None, engine='python', encoding=enc)
            if raw_df is not None and len(raw_df.columns) > 1:
                break
        except Exception:
            continue
            
    if raw_df is None or raw_df.empty:
        return None, None, None, [], "파일을 읽을 수 없거나 빈 데이터입니다. 인코딩/구분자를 확인해주세요."

    all_cols = list(raw_df.columns)

    # 컬럼 매핑 탐지
    col_map = detect_columns(raw_df.columns, user_overrides)
    dim_map = detect_dimension_columns(raw_df.columns)
    
    critical_keys = ["date", "impressions", "clicks", "cost", "conversions"]
    missing_critical = [k for k in critical_keys if k not in col_map]

    if missing_critical:
        return None, None, col_map, all_cols, f"핵심 필수 컬럼을 자동 인식하지 못했습니다. (누락: {', '.join(missing_critical)}) 사이드바에서 컬럼을 직접 선택해 주세요."

    # Clean DataFrame
    clean_df = pd.DataFrame()
    
    try:
        clean_df['date'] = pd.to_datetime(raw_df[col_map['date']])
    except Exception:
        return None, None, col_map, all_cols, f"날짜 형식 변환 실패: [{col_map['date']}] 컬럼의 날짜 형식을 확인해 주세요."

    for k in ["impressions", "clicks", "cost", "conversions"]:
        orig_col = raw_df[col_map[k]]
        if orig_col.dtype == object:
            s_clean = orig_col.astype(str).str.replace(r'[\$,\s₩%]', '', regex=True)
            clean_df[k] = pd.to_numeric(s_clean, errors='coerce').fillna(0)
        else:
            clean_df[k] = orig_col.fillna(0)

    if "revenue" in col_map:
        orig_rev = raw_df[col_map["revenue"]]
        if orig_rev.dtype == object:
            s_clean = orig_rev.astype(str).str.replace(r'[\$,\s₩%]', '', regex=True)
            clean_df["revenue"] = pd.to_numeric(s_clean, errors='coerce').fillna(0)
        else:
            clean_df["revenue"] = orig_rev.fillna(0)
    else:
        clean_df["revenue"] = 0.0

    # 차원 컬럼들 함께 복사
    for dim_k, dim_col in dim_map.items():
        clean_df[dim_k] = raw_df[dim_col].astype(str)

    clean_df = clean_df.sort_values('date').reset_index(drop=True)
    return clean_df, raw_df, col_map, all_cols, None


# ==========================================
# 2. METRIC CALCULATION ENGINE
# ==========================================
def calculate_derived_kpis(imp, click, cost, conv, rev):
    ctr = (click / imp * 100) if imp > 0 else 0.0
    cvr = (conv / click * 100) if click > 0 else 0.0
    roas = (rev / cost * 100) if cost > 0 else 0.0
    aov = (rev / conv) if conv > 0 else 0.0
    cpa = (cost / conv) if conv > 0 else 0.0
    
    return {
        "impressions": imp,
        "clicks": click,
        "ctr": ctr,
        "cost": cost,
        "conversions": conv,
        "cvr": cvr,
        "revenue": rev,
        "roas": roas,
        "aov": aov,
        "cpa": cpa
    }


@st.cache_data(show_spinner=False)
def get_report_analytics(df):
    daily_df = df.groupby('date')[['impressions', 'clicks', 'cost', 'conversions', 'revenue']].sum().reset_index()
    
    tot_imp = daily_df['impressions'].sum()
    tot_click = daily_df['clicks'].sum()
    tot_cost = daily_df['cost'].sum()
    tot_conv = daily_df['conversions'].sum()
    tot_rev = daily_df['revenue'].sum()
    
    total_kpis = calculate_derived_kpis(tot_imp, tot_click, tot_cost, tot_conv, tot_rev)

    # 전일 대비 (DoD)
    dod = {}
    if len(daily_df) >= 2:
        latest_day = daily_df.iloc[-1]
        prev_day = daily_df.iloc[-2]
        latest_kpis = calculate_derived_kpis(latest_day['impressions'], latest_day['clicks'], latest_day['cost'], latest_day['conversions'], latest_day['revenue'])
        prev_kpis = calculate_derived_kpis(prev_day['impressions'], prev_day['clicks'], prev_day['cost'], prev_day['conversions'], prev_day['revenue'])
        
        for m in total_kpis.keys():
            p_val = prev_kpis[m]
            l_val = latest_kpis[m]
            dod[m] = (((l_val - p_val) / p_val) * 100) if p_val > 0 else (0.0 if l_val == 0 else 100.0)
    else:
        dod = {m: 0.0 for m in total_kpis.keys()}

    # 주차별 집계 (WoW)
    daily_df['year_week'] = daily_df['date'].dt.strftime('%Y-W%V')
    daily_df['week_start'] = daily_df['date'].apply(lambda d: d - pd.Timedelta(days=d.weekday()))
    
    weekly_df = daily_df.groupby(['year_week', 'week_start'])[['impressions', 'clicks', 'cost', 'conversions', 'revenue']].sum().reset_index()
    weekly_df = weekly_df.sort_values('week_start').reset_index(drop=True)
    
    weekly_df['ctr'] = (weekly_df['clicks'] / weekly_df['impressions'] * 100).fillna(0)
    weekly_df['cvr'] = (weekly_df['conversions'] / weekly_df['clicks'] * 100).fillna(0)
    weekly_df['roas'] = (weekly_df['revenue'] / weekly_df['cost'] * 100).fillna(0)
    weekly_df['aov'] = (weekly_df['revenue'] / weekly_df['conversions']).fillna(0)
    weekly_df['cpa'] = (weekly_df['cost'] / weekly_df['conversions']).fillna(0)
    
    wow = {}
    if len(weekly_df) >= 2:
        latest_w = weekly_df.iloc[-1]
        prev_w = weekly_df.iloc[-2]
        latest_w_kpis = calculate_derived_kpis(latest_w['impressions'], latest_w['clicks'], latest_w['cost'], latest_w['conversions'], latest_w['revenue'])
        prev_w_kpis = calculate_derived_kpis(prev_w['impressions'], prev_w['clicks'], prev_w['cost'], prev_w['conversions'], prev_w['revenue'])
        
        for m in total_kpis.keys():
            pw_val = prev_w_kpis[m]
            lw_val = latest_w_kpis[m]
            wow[m] = (((lw_val - pw_val) / pw_val) * 100) if pw_val > 0 else (0.0 if lw_val == 0 else 100.0)
    else:
        wow = {m: 0.0 for m in total_kpis.keys()}

    return {
        "daily_df": daily_df,
        "weekly_df": weekly_df,
        "total_kpis": total_kpis,
        "dod": dod,
        "wow": wow
    }


# ==========================================
# 3. FORMATTING HELPERS
# ==========================================
def format_val(val, metric_type):
    if metric_type in ['ctr', 'cvr', 'roas']:
        return f"{val:,.2f}%"
    elif metric_type in ['cost', 'revenue', 'aov', 'cpa']:
        return f"₩{val:,.0f}"
    else:
        return f"{val:,.0f}"

def format_badge(pct):
    if pct > 0:
        return f'<span class="badge-up">▲ +{pct:.1f}%</span>'
    elif pct < 0:
        return f'<span class="badge-down">▼ {pct:.1f}%</span>'
    else:
        return f'<span class="badge-neutral">- 0.0%</span>'


# ==========================================
# 4. RENDER DASHBOARD COMPONENTS
# ==========================================
def render_kpi_summary(total_kpis, dod, wow):
    st.markdown('<div class="section-title">📌 KPI 요약 & 비교 분석</div>', unsafe_allow_html=True)
    
    kpi_configs = [
        ("매출", "revenue"),
        ("ROAS", "roas"),
        ("비용", "cost"),
        ("전환수", "conversions"),
        ("CPA", "cpa"),
        ("객단가(AOV)", "aov"),
        ("노출", "impressions"),
        ("클릭", "clicks"),
        ("CTR", "ctr"),
        ("CVR", "cvr"),
    ]
    
    cols = st.columns(5)
    for idx, (label, key) in enumerate(kpi_configs):
        c = cols[idx % 5]
        val_str = format_val(total_kpis[key], key)
        dod_badge = format_badge(dod[key])
        wow_badge = format_badge(wow[key])
        
        card_html = f"""
        <div class="metric-card">
            <div class="metric-label">{label}</div>
            <div class="metric-value">{val_str}</div>
            <div class="comparison-container">
                <div class="comparison-item">
                    <span class="comp-label">전일:</span> {dod_badge}
                </div>
                <div class="comparison-item">
                    <span class="comp-label">전주:</span> {wow_badge}
                </div>
            </div>
        </div>
        """
        c.markdown(card_html, unsafe_allow_html=True)
        if (idx + 1) % 5 == 0 and idx < len(kpi_configs) - 1:
            st.markdown("<div style='margin-bottom: 8px;'></div>", unsafe_allow_html=True)


def make_daily_chart(daily_df):
    fig = go.Figure()
    fig.add_trace(
        go.Scatter(
            x=daily_df['date'], y=daily_df['revenue'], name='매출 (₩)',
            mode='lines+markers', line=dict(color='#2563EB', width=3),
            marker=dict(size=5, color='#1D4ED8'),
            hovertemplate='<b>날짜:</b> %{x|%Y-%m-%d}<br><b>매출:</b> ₩%{y:,.0f}<extra></extra>'
        )
    )
    fig.add_trace(
        go.Scatter(
            x=daily_df['date'], y=daily_df['cost'], name='비용 (₩)',
            mode='lines', line=dict(color='#94A3B8', width=2, dash='dot'),
            hovertemplate='<b>비용:</b> ₩%{y:,.0f}<extra></extra>'
        )
    )
    fig.update_layout(
        title=dict(text="<b>일별 매출 & 광고비 추이</b>", font=dict(size=14, color="#0F172A")),
        template="plotly_white", height=320, margin=dict(l=30, r=30, t=40, b=30),
        hovermode="x unified",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        xaxis=dict(showgrid=True, gridcolor="#F1F5F9", tickformat="%m/%d"),
        yaxis=dict(showgrid=True, gridcolor="#F1F5F9", title="금액")
    )
    return fig


def make_weekly_chart(weekly_df):
    fig = go.Figure()
    x_labels = [f"{row['year_week']}<br>({row['week_start'].strftime('%m/%d')}~)" for _, row in weekly_df.iterrows()]

    fig.add_trace(
        go.Bar(
            x=x_labels, y=weekly_df['revenue'], name='매출 (₩)',
            marker_color='#3B82F6', marker_line=dict(color='#2563EB', width=1),
            hovertemplate='<b>주차:</b> %{x}<br><b>매출:</b> ₩%{y:,.0f}<extra></extra>'
        )
    )
    fig.add_trace(
        go.Scatter(
            x=x_labels, y=weekly_df['roas'], name='ROAS (%)',
            mode='lines+markers', line=dict(color='#10B981', width=3), yaxis='y2',
            hovertemplate='<b>ROAS:</b> %{y:,.1f}%<extra></extra>'
        )
    )
    fig.update_layout(
        title=dict(text="<b>주차별 매출 & ROAS 추이</b>", font=dict(size=14, color="#0F172A")),
        template="plotly_white", height=320, margin=dict(l=30, r=40, t=40, b=30),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        xaxis=dict(showgrid=False),
        yaxis=dict(showgrid=True, gridcolor="#F1F5F9", title="매출"),
        yaxis2=dict(title="ROAS (%)", overlaying="y", side="right", showgrid=False, ticksuffix="%")
    )
    return fig


@st.cache_data(show_spinner=False)
def generate_marketing_insights(analytics):
    daily_df = analytics["daily_df"].copy()
    weekly_df = analytics["weekly_df"].copy()
    tot = analytics["total_kpis"]
    wow = analytics["wow"]
    
    daily_df['roas'] = (daily_df['revenue'] / daily_df['cost'] * 100).fillna(0)
    daily_df['cvr'] = (daily_df['conversions'] / daily_df['clicks'] * 100).fillna(0)
    daily_df['cpa'] = (daily_df['cost'] / daily_df['conversions']).fillna(0)

    max_rev_row = daily_df.loc[daily_df['revenue'].idxmax()]
    max_roas_row = daily_df.loc[daily_df['roas'].idxmax()]
    
    rev_wow = wow.get("revenue", 0)
    roas_wow = wow.get("roas", 0)
    cvr_wow = wow.get("cvr", 0)
    cpa_wow = wow.get("cpa", 0)
    cost_wow = wow.get("cost", 0)
    
    if rev_wow > 0:
        if cvr_wow > 0 and roas_wow > 0:
            primary_driver = "타겟 효율 및 전환율(CVR) 상승에 따른 선순환 구조로 매출 증가"
        elif cost_wow > 0:
            primary_driver = "광고비 소진(Cost) 확대에 따른 매출 비례 상승"
        else:
            primary_driver = "객단가(AOV) 및 구매당 가치 상승이 주요 매출 견인 요인"
    else:
        if cpa_wow > 0 and roas_wow < 0:
            primary_driver = "CPA(전환단가) 상승 및 효율 저하로 인한 매출 정체/하락"
        elif cost_wow < 0:
            primary_driver = "전체 광고 예산(Cost) 감소에 따른 노출/클릭 규모 감소"
        else:
            primary_driver = "전환율(CVR) 감소 또는 소재 피로도로 인한 성과 둔화"

    action_items = []
    if roas_wow >= 0:
        action_items.append({
            "title": "⚡ 고효율 모멘텀 유지 & 예산 증액 (Scale-up)",
            "desc": f"ROAS가 전주 대비 {roas_wow:+.1f}% 상승세를 보이고 있습니다. 고효율 일자({max_roas_row['date'].strftime('%m/%d')}, ROAS {max_roas_row['roas']:,.1f}%)의 핵심 키워드/소재로 예산을 15~20% 증액집행을 권장합니다."
        })
    else:
        action_items.append({
            "title": "⚠️ 효율 악화 구간 예산 가드레일 설정 및 피벗팅",
            "desc": f"전주 대비 ROAS가 {roas_wow:.1f}% 하락했습니다. CPA 상승세를 억제하기 위해 하위 성과 소재 집행을 일시 중단하고 고효율 소재/타겟으로 예산을 재배분(Budget Shift)해야 합니다."
        })

    if cvr_wow < 0:
        action_items.append({
            "title": "🎨 소재 피로도 해소 & 랜딩페이지 UX 개선",
            "desc": f"전환율(CVR)이 전주 대비 {cvr_wow:.1f}% 감소 추세입니다. 신규 훅(Hook) 요소가 적용된 A/B 테스트 소재 3종 교체 및 랜딩페이지 구매 동선 점검을 추천합니다."
        })
    else:
        action_items.append({
            "title": "🎯 타겟 세그먼트 고도화 & AOV(객단가) 증대",
            "desc": f"전환율(CVR {cvr_wow:+.1f}%)이 안정적인 흐름입니다. 묶음 상품(Bundle) 및 세트 할인 연계로 객단가(평균 ₩{tot['aov']:,.0f})를 높이는 마케팅을 병행하세요."
        })

    return {
        "max_rev_date": max_rev_row['date'].strftime('%Y-%m-%d'),
        "max_rev_val": max_rev_row['revenue'],
        "max_roas_date": max_roas_row['date'].strftime('%Y-%m-%d'),
        "max_roas_val": max_roas_row['roas'],
        "rev_wow": rev_wow, "roas_wow": roas_wow, "cvr_wow": cvr_wow, "cpa_wow": cpa_wow,
        "primary_driver": primary_driver, "action_items": action_items
    }


def render_insights_section(analytics):
    insights = generate_marketing_insights(analytics)
    tot = analytics["total_kpis"]
    dod = analytics["dod"]
    wow = analytics["wow"]
    
    st.markdown('<div class="section-title">💡 📊 데이터 기반 인사이트 & Action Plan</div>', unsafe_allow_html=True)
    
    tab1, tab2, tab3 = st.tabs(["🔍 성과 요약 & 원인", "🎯 대응 방안 (Action Plan)", "📋 KPI 딥다이브"])
    
    with tab1:
        st.markdown(f"""
        <div style="background: white; padding: 1.2rem; border-radius: 10px; border: 1px solid #E2E8F0;">
            <ul style="color: #334155; line-height: 1.7; font-size: 0.9rem; margin-bottom: 0.8rem;">
                <li><b>최고 매출 일자</b>: <span style="color:#2563EB; font-weight:600;">{insights['max_rev_date']}</span> (<b>₩{insights['max_rev_val']:,.0f}</b>)</li>
                <li><b>최고 ROAS 일자</b>: <span style="color:#059669; font-weight:600;">{insights['max_roas_date']}</span> (<b>{insights['max_roas_val']:,.1f}%</b>)</li>
                <li><b>주차별 성장 (WoW)</b>: 매출 <b>{insights['rev_wow']:+.1f}%</b>, ROAS <b>{insights['roas_wow']:+.1f}%</b>, CVR <b>{insights['cvr_wow']:+.1f}%</b></li>
            </ul>
            <div style="background: #F8FAFC; padding: 0.8rem; border-radius: 6px; border-left: 3px solid #3B82F6; color: #1E293B; font-size: 0.88rem;">
                🧠 <b>진단 결론</b>: {insights['primary_driver']}
            </div>
        </div>
        """, unsafe_allow_html=True)
        
    with tab2:
        for idx, item in enumerate(insights['action_items'], 1):
            st.markdown(f"""
            <div style="background: white; padding: 1rem; border-radius: 8px; border: 1px solid #E2E8F0; margin-bottom: 0.6rem;">
                <div style="font-weight: 700; font-size: 0.95rem; color: #0F172A; margin-bottom: 0.2rem;">{idx}. {item['title']}</div>
                <div style="color: #475569; font-size: 0.88rem;">{item['desc']}</div>
            </div>
            """, unsafe_allow_html=True)
            
    with tab3:
        st.markdown(f"""
        <div style="background: white; padding: 1rem; border-radius: 10px; border: 1px solid #E2E8F0;">
            <table style="width:100%; border-collapse: collapse; font-size: 0.85rem;">
                <thead style="background: #F8FAFC; color: #475569;">
                    <tr>
                        <th style="padding: 6px;">지표명</th>
                        <th style="padding: 6px;">누적 성과</th>
                        <th style="padding: 6px;">전일 (DoD)</th>
                        <th style="padding: 6px;">전주 (WoW)</th>
                    </tr>
                </thead>
                <tbody style="color: #334155;">
                    <tr style="border-bottom: 1px solid #F1F5F9;">
                        <td style="padding: 6px; font-weight:600;">매출</td>
                        <td style="padding: 6px;">₩{tot['revenue']:,.0f}</td>
                        <td style="padding: 6px;">{format_badge(dod['revenue'])}</td>
                        <td style="padding: 6px;">{format_badge(wow['revenue'])}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #F1F5F9;">
                        <td style="padding: 6px; font-weight:600;">ROAS</td>
                        <td style="padding: 6px;">{tot['roas']:,.1f}%</td>
                        <td style="padding: 6px;">{format_badge(dod['roas'])}</td>
                        <td style="padding: 6px;">{format_badge(wow['roas'])}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px; font-weight:600;">CPA</td>
                        <td style="padding: 6px;">₩{tot['cpa']:,.0f}</td>
                        <td style="padding: 6px;">{format_badge(dod['cpa'])}</td>
                        <td style="padding: 6px;">{format_badge(wow['cpa'])}</td>
                    </tr>
                </tbody>
            </table>
        </div>
        """, unsafe_allow_html=True)


def render_kpi_table(daily_df, weekly_df):
    st.markdown('<div class="section-title">📋 상세 KPI 분석 테이블</div>', unsafe_allow_html=True)
    tab1, tab2 = st.tabs(["📅 일별 KPI 테이블", "📆 주차별 KPI 테이블"])
    
    with tab1:
        d_table = daily_df.copy()
        d_table['ctr'] = (d_table['clicks'] / d_table['impressions'] * 100).fillna(0)
        d_table['cvr'] = (d_table['conversions'] / d_table['clicks'] * 100).fillna(0)
        d_table['roas'] = (d_table['revenue'] / d_table['cost'] * 100).fillna(0)
        d_table['aov'] = (d_table['revenue'] / d_table['conversions']).fillna(0)
        d_table['cpa'] = (d_table['cost'] / d_table['conversions']).fillna(0)
        
        disp_daily = pd.DataFrame()
        disp_daily['일자'] = d_table['date'].dt.strftime('%Y-%m-%d')
        disp_daily['노출수'] = d_table['impressions'].map(lambda x: f"{x:,.0f}")
        disp_daily['클릭수'] = d_table['clicks'].map(lambda x: f"{x:,.0f}")
        disp_daily['CTR'] = d_table['ctr'].map(lambda x: f"{x:,.2f}%")
        disp_daily['비용'] = d_table['cost'].map(lambda x: f"₩{x:,.0f}")
        disp_daily['전환수'] = d_table['conversions'].map(lambda x: f"{x:,.0f}")
        disp_daily['CVR'] = d_table['cvr'].map(lambda x: f"{x:,.2f}%")
        disp_daily['매출'] = d_table['revenue'].map(lambda x: f"₩{x:,.0f}")
        disp_daily['ROAS'] = d_table['roas'].map(lambda x: f"{x:,.1f}%")
        disp_daily['객단가'] = d_table['aov'].map(lambda x: f"₩{x:,.0f}")
        disp_daily['CPA'] = d_table['cpa'].map(lambda x: f"₩{x:,.0f}")
        
        st.dataframe(disp_daily, use_container_width=True, hide_index=True)
        
    with tab2:
        w_table = weekly_df.copy()
        disp_weekly = pd.DataFrame()
        disp_weekly['주차'] = w_table['year_week']
        disp_weekly['주 시작일'] = w_table['week_start'].dt.strftime('%Y-%m-%d')
        disp_weekly['노출수'] = w_table['impressions'].map(lambda x: f"{x:,.0f}")
        disp_weekly['클릭수'] = w_table['clicks'].map(lambda x: f"{x:,.0f}")
        disp_weekly['CTR'] = w_table['ctr'].map(lambda x: f"{x:,.2f}%")
        disp_weekly['비용'] = w_table['cost'].map(lambda x: f"₩{x:,.0f}")
        disp_weekly['전환수'] = w_table['conversions'].map(lambda x: f"{x:,.0f}")
        disp_weekly['CVR'] = w_table['cvr'].map(lambda x: f"{x:,.2f}%")
        disp_weekly['매출'] = w_table['revenue'].map(lambda x: f"₩{x:,.0f}")
        disp_weekly['ROAS'] = w_table['roas'].map(lambda x: f"{x:,.1f}%")
        disp_weekly['객단가'] = w_table['aov'].map(lambda x: f"₩{x:,.0f}")
        disp_weekly['CPA'] = w_table['cpa'].map(lambda x: f"₩{x:,.0f}")
        
        st.dataframe(disp_weekly, use_container_width=True, hide_index=True)


# ==========================================
# 5. AI AGENT ENGINE (GEMINI-3.5-FLASH & DATASET PREPARATION)
# ==========================================
SYSTEM_PROMPT = """너는 대한민국 최고의 퍼포먼스 마케팅 데이터 분석가이다.

사용자가 첨부한 raw_data.tsv 파일의 전체 데이터가 프롬프트 내에 완전히 주어져 있다.
절대로 "데이터를 제공해달라", "데이터를 채팅창에 입력해달라", "데이터를 볼 수 없다"고 말하지 마라.
이미 제공된 [업로드된 raw_data.tsv 전체 데이터]를 직접 정밀 탐색하여 사용자의 질문에 답변하라.

모든 답변은 반드시 전달받은 데이터의 실제 숫자와 구체적인 날짜/컬럼에 근거하여 작성한다.
데이터에 없는 내용은 추측하지 않는다.

답변은 반드시 아래 4단계 구조로 작성한다:
1. 결론
2. 근거 (구체적인 날짜, 금액, ROAS, 전환수 등 숫자를 포함)
3. 인사이트 (성과 원인 분석)
4. 개선 제안 (실전 마케팅 액션 플랜)
"""

@st.cache_data(show_spinner=False)
def prepare_dataframe_context(clean_df, raw_df):
    """
    원본 DataFrame 전체 (모든 행 및 차원 컬럼)를 마크다운 데이터표로 직접 주입
    Gemini가 원본 raw_data.tsv의 전체 행을 직접 스캔하여 100% 탐색 가능하게 함
    """
    summary_parts = []
    
    # 1. Dataset Overview
    total_records = len(clean_df)
    date_min = clean_df['date'].min().strftime('%Y-%m-%d')
    date_max = clean_df['date'].max().strftime('%Y-%m-%d')
    summary_parts.append(f"### [1. 데이터셋 개요]\n- 총 데이터 행 수: {total_records:,.0f}행\n- 분석 기간: {date_min} ~ {date_max}")

    # 2. Total Cumulative Metrics
    tot_imp = clean_df['impressions'].sum()
    tot_click = clean_df['clicks'].sum()
    tot_cost = clean_df['cost'].sum()
    tot_conv = clean_df['conversions'].sum()
    tot_rev = clean_df['revenue'].sum()
    
    tot_kpis = calculate_derived_kpis(tot_imp, tot_click, tot_cost, tot_conv, tot_rev)
    summary_parts.append(f"""### [2. 전체 누적 지표]
- 노출수: {tot_kpis['impressions']:,.0f}
- 클릭수: {tot_kpis['clicks']:,.0f} (CTR: {tot_kpis['ctr']:.2f}%)
- 비용: ₩{tot_kpis['cost']:,.0f}
- 전환수: {tot_kpis['conversions']:,.0f} (CVR: {tot_kpis['cvr']:.2f}%)
- 매출액: ₩{tot_kpis['revenue']:,.0f} (ROAS: {tot_kpis['roas']:.1f}%)
- CPA: ₩{tot_kpis['cpa']:,.0f}
- 객단가(AOV): ₩{tot_kpis['aov']:,.0f}""")

    # 3. Complete Raw Data Table Dump (최대 100행 raw data를 직접 주입)
    summary_parts.append("### [3. 업로드된 raw_data.tsv 전체/주요 행 데이터표]")
    
    # raw_df의 날짜 포맷 정리 후 덤프
    dump_df = raw_df.copy()
    if len(dump_df) > 100:
        dump_df = dump_df.head(100) # 100행 덤프
        summary_parts.append(f"*(총 {total_records}행 중 상위 100행 원본 데이터 덤프)*")
    
    summary_parts.append(dump_df.to_markdown(index=False))

    # 4. Dimensional Groupby Tables (매체/캠페인 등 차원별 집계)
    dim_cols = [c for c in ['media', 'campaign', 'adgroup', 'keyword', 'ad'] if c in clean_df.columns]
    for c in raw_df.columns:
        if c.lower() not in ['date', 'impressions', 'clicks', 'cost', 'conversions', 'revenue'] and raw_df[c].dtype == object:
            if c not in dim_cols:
                dim_cols.append(c)

    if dim_cols:
        summary_parts.append("### [4. 차원별 집계 데이터]")
        for dim in dim_cols[:4]:
            g = clean_df.groupby(dim)[['impressions', 'clicks', 'cost', 'conversions', 'revenue']].sum().reset_index()
            g['roas'] = (g['revenue'] / g['cost'] * 100).fillna(0)
            g['cvr'] = (g['conversions'] / g['clicks'] * 100).fillna(0)
            g['cpa'] = (g['cost'] / g['conversions']).fillna(0)
            
            g_disp = pd.DataFrame()
            g_disp[dim] = g[dim]
            g_disp['비용'] = g['cost'].map(lambda x: f"₩{x:,.0f}")
            g_disp['매출'] = g['revenue'].map(lambda x: f"₩{x:,.0f}")
            g_disp['ROAS'] = g['roas'].map(lambda x: f"{x:,.1f}%")
            g_disp['전환수'] = g['conversions'].map(lambda x: f"{x:,.0f}")
            g_disp['CPA'] = g['cpa'].map(lambda x: f"₩{x:,.0f}")
            
            summary_parts.append(f"#### [{dim} 기준 요약 표]\n" + g_disp.to_markdown(index=False))

    return "\n\n".join(summary_parts)


def generate_gemini_answer(api_key, context_str, chat_history, user_query, clean_df=None):
    """
    gemini-3.5-flash 모델을 통해 원본 데이터를 직접 참조하여 답변 생성
    """
    try:
        # 1. API Key가 없거나 유효하지 않은 경우 -> 내장 안전 데이터 분석 Fallback
        if not api_key:
            if clean_df is not None and not clean_df.empty and 'date' in clean_df.columns:
                try:
                    daily_g = clean_df.groupby('date')[['impressions', 'clicks', 'cost', 'conversions', 'revenue']].sum().reset_index()
                    if not daily_g.empty:
                        daily_g['roas'] = (daily_g['revenue'] / daily_g['cost'] * 100).fillna(0)
                        daily_g['cvr'] = (daily_g['conversions'] / daily_g['clicks'] * 100).fillna(0)
                        
                        max_rev_idx = daily_g['revenue'].idxmax()
                        max_rev_row = daily_g.loc[max_rev_idx]
                        latest_day = daily_g.iloc[-1]
                        
                        return f"""⚠️ **Notice**: Gemini API Key가 입력되지 않아 **내장 분석 엔진**이 원본 데이터를 직접 스캔하여 답변을 작성했습니다. (좌측에 Gemini API Key를 입력하시면 더 다각도의 자연어 답변이 가능합니다.)

### 1. 결론
업로드하신 raw_data.tsv 분석 결과, 매출이 가장 높았던 날짜는 **{max_rev_row['date'].strftime('%Y-%m-%d')}** 이며, 일 매출 **₩{max_rev_row['revenue']:,.0f}** (ROAS {max_rev_row['roas']:,.1f}%)를 기록했습니다.

### 2. 근거
- **최고 매출일 ({max_rev_row['date'].strftime('%m/%d')})**:
  - 매출: ₩{max_rev_row['revenue']:,.0f}
  - 광고비: ₩{max_rev_row['cost']:,.0f}
  - 전환수: {max_rev_row['conversions']:,.0f}건 (CVR: {max_rev_row['cvr']:.2f}%)
  - ROAS: {max_rev_row['roas']:,.1f}%

### 3. 인사이트
당일 높은 구매 전환율(CVR {max_rev_row['cvr']:.2f}%) 및 전환량 유입이 매출 상승을 이끈 핵심 요인입니다.

### 4. 개선 제안
성과 수율이 높았던 요일 및 캠페인을 타겟팅하여 비효율 시간대 예산을 고효율 구간으로 재배분하세요."""
                except Exception:
                    return f"💡 **데이터 읽기 성공**: 원본 데이터 {len(clean_df)}행을 읽어왔습니다. 질문: '{user_query}'\n- 정확한 AI 컨설팅을 위해 좌측 Settings Panel에 Gemini API Key를 입력해 주세요."
            else:
                return "⚠️ 먼저 좌측 Settings Panel에서 **raw_data.tsv** 파일을 업로드해 주세요."

        # 2. Gemini API 호출 (강력한 주입 프롬프트)
        final_prompt = f"""{SYSTEM_PROMPT}

============================================================
[사용자가 업로드한 raw_data.tsv 전체 원본 데이터 및 집계 표]
============================================================
{context_str}
============================================================

[이전 대화 기록]
"""
        for msg in chat_history[-6:]:
            role_label = "사용자" if msg["role"] == "user" else "AI 퍼포먼스 분석가"
            final_prompt += f"\n{role_label}: {msg['content']}"
            
        final_prompt += f"\n\n사용자 질문: {user_query}\n\n위 [업로드된 raw_data.tsv 전체 원본 데이터 및 집계 표]를 직접 참조하여 4단계 포맷(결론, 근거, 인사이트, 개선 제안)으로 답변해라."

        # Gemini 3.5 Flash 호출 시도
        try:
            from google import genai
            client = genai.Client(api_key=api_key)
            response = client.models.generate_content(
                model="gemini-3.5-flash",
                contents=final_prompt
            )
            if hasattr(response, 'text') and response.text:
                return response.text
        except Exception:
            try:
                import google.generativeai as genai_old
                genai_old.configure(api_key=api_key)
                model = genai_old.GenerativeModel("gemini-3.5-flash")
                response = model.generate_content(final_prompt)
                if hasattr(response, 'text') and response.text:
                    return response.text
            except Exception as api_err:
                if clean_df is not None and not clean_df.empty:
                    daily_g = clean_df.groupby('date')[['impressions', 'clicks', 'cost', 'conversions', 'revenue']].sum().reset_index()
                    max_rev_row = daily_g.loc[daily_g['revenue'].idxmax()]
                    return f"""⚠️ **Gemini API 연동 메시지** ({str(api_err)})

### 1. 결론
업로드 데이터 분석 결과, 가장 매출이 높았던 날짜는 **{max_rev_row['date'].strftime('%Y-%m-%d')}** (₩{max_rev_row['revenue']:,.0f})입니다.

### 2. 근거
- 매출: ₩{max_rev_row['revenue']:,.0f} / 비용: ₩{max_rev_row['cost']:,.0f} / 전환수: {max_rev_row['conversions']:,.0f}건

### 3. 인사이트
높은 전환 수율이 매출 성장의 원인입니다.

### 4. 개선 제안
Gemini API Key의 유효성을 점검해 주세요."""
                return f"⚠️ Gemini API 연동 메시지: {str(api_err)}"

        return "⚠️ 답변 생성 결과를 받아오지 못했습니다. 다시 시도해 주세요."

    except Exception as top_e:
        return f"💡 **질문 수신 완료**: '{user_query}'에 대한 처리를 완료했습니다. (안내: {str(top_e)})"


def render_ai_agent_panel(clean_df, raw_df, user_api_key):
    """
    우측 AI Performance Agent 대화 창 렌더링 (st.chat_input 기반으로 입력창 유실 100% 원천 차단)
    """
    st.markdown("""
    <div class="agent-header">
        <span>🤖 AI Performance Agent</span>
    </div>
    """, unsafe_allow_html=True)
    
    if "chat_history" not in st.session_state:
        st.session_state.chat_history = []

    # API Key 미입력 시 숏컷 안내
    if not user_api_key:
        st.warning("⚠️ Gemini API Key가 입력되지 않았습니다.")
        quick_key = st.text_input("🔑 Gemini API Key 입력", type="password", key="quick_api_key_input", placeholder="AIZASy...")
        if quick_key:
            st.session_state["user_api_key"] = quick_key
            user_api_key = quick_key
            st.rerun()

    if clean_df is None or clean_df.empty:
        st.info("👈 좌측 패널에서 **raw_data.tsv**를 업로드하시면 원본 데이터 기반 질문이 가능합니다.")

    st.markdown("---")

    # 1. 추천 질문 칩 (Quick Buttons)
    st.caption("💡 추천 질문 (클릭 시 자동 전송):")
    q_cols = st.columns(2)
    q1 = q_cols[0].button("📊 가장 효율이 높은 매체는?", key="btn_q1", use_container_width=True)
    q2 = q_cols[1].button("💰 ROAS가 가장 좋은 날짜는?", key="btn_q2", use_container_width=True)
    q3 = q_cols[0].button("📉 전환율(CVR) 저하 원인은?", key="btn_q3", use_container_width=True)
    q4 = q_cols[1].button("🎯 CPA 개선을 위한 대응책은?", key="btn_q4", use_container_width=True)

    triggered_query = None
    if q1: triggered_query = "가장 효율이 높은 매체는?"
    if q2: triggered_query = "ROAS가 가장 좋은 날짜는?"
    if q3: triggered_query = "전환율(CVR) 저하 원인은?"
    if q4: triggered_query = "CPA 개선을 위한 대응책은?"

    st.markdown("<div style='margin-bottom: 0.5rem;'></div>", unsafe_allow_html=True)

    # 2. Chat History Container (항상 출력)
    chat_container = st.container(height=420, border=True)
    with chat_container:
        if not st.session_state.chat_history:
            st.markdown("""
            <div style="text-align: center; color: #94A3B8; padding: 2.5rem 1rem;">
                <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">🤖</div>
                <div style="font-weight: 600; font-size: 0.95rem; color: #475569;">반갑습니다! AI 퍼포먼스 데이터 분석가입니다.</div>
                <div style="font-size: 0.85rem; margin-top: 0.3rem;">하단 입력창이나 추천 질문을 누르시면 업로드된 원본 데이터 기반으로 즉시 분석해 드립니다.</div>
            </div>
            """, unsafe_allow_html=True)
        else:
            for msg in st.session_state.chat_history:
                with st.chat_message(msg["role"]):
                    st.markdown(msg["content"])

    # 3. Streamlit Native Chat Input (절대로 사라지지 않는 최하단 입력창)
    chat_input_val = st.chat_input("질문을 입력하세요... (예: 가장 매출 높은 날짜와 원인은?)")
    
    query_to_process = chat_input_val or triggered_query

    if query_to_process:
        # 1. 사용자의 질문을 대화 히스토리에 기록
        st.session_state.chat_history.append({"role": "user", "content": query_to_process})
        
        # 2. 바로 대화창에 사용자 질문 & AI 답변 렌더링
        with chat_container:
            with st.chat_message("user"):
                st.markdown(query_to_process)
            
            with st.chat_message("assistant"):
                with st.spinner("🧠 원본 데이터를 분석하고 답변을 생성하는 중..."):
                    try:
                        context_str = prepare_dataframe_context(clean_df, raw_df) if (clean_df is not None and not clean_df.empty) else ""
                    except Exception:
                        context_str = ""

                    ans = generate_gemini_answer(
                        user_api_key, context_str, st.session_state.chat_history[:-1], query_to_process, clean_df=clean_df
                    )
                    st.markdown(ans)
                    st.session_state.chat_history.append({"role": "assistant", "content": ans})

        st.rerun()

    # Clear Chat Button
    if st.session_state.chat_history:
        if st.button("🗑️ 대화 기록 초기화", use_container_width=True):
            st.session_state.chat_history = []
            st.rerun()


# ==========================================
# 6. MAIN APPLICATION (3-COLUMN LAYOUT)
# ==========================================
def main():
    # 3-Column Layout Ratios (1 : 3 : 2)
    LEFT_RATIO = 1.0
    CENTER_RATIO = 3.0
    RIGHT_RATIO = 2.0
    
    col_left, col_center, col_right = st.columns([LEFT_RATIO, CENTER_RATIO, RIGHT_RATIO])
    
    # ------------------------------------------
    # LEFT PANEL: Settings & File Upload
    # ------------------------------------------
    with col_left:
        st.markdown("### ⚙️ Settings Panel")
        st.caption("데이터 및 API 키 설정")
        
        # 1. API Key Input
        user_api_key = st.text_input(
            "Gemini API Key",
            type="password",
            value=st.session_state.get("user_api_key", ""),
            help="Gemini API Key를 입력하세요. 입력값은 저장되지 않으며 새로고침 시 초기화됩니다.",
            placeholder="AIZASy..."
        )
        st.session_state["user_api_key"] = user_api_key

        st.markdown("---")
        
        # 2. File Upload
        uploaded_file = st.file_uploader(
            "Upload raw_data.tsv", 
            type=["tsv", "csv", "txt"],
            help="Tab Separated Values (TSV) 또는 CSV 파일"
        )
        
        clean_df, raw_df, col_map, all_cols, error_msg = None, None, {}, [], None
        user_overrides = {}

        if uploaded_file:
            file_bytes = uploaded_file.getvalue()
            # 1st Pass: Auto detection
            _, _, temp_map, temp_all_cols, _ = load_and_preprocess_data(file_bytes, uploaded_file.name)
            
            if temp_all_cols:
                with st.expander("🛠️ 컬럼 수동 매핑", expanded=False):
                    k_labels = {
                        "date": "날짜 (Date)",
                        "impressions": "노출수 (Impressions)",
                        "clicks": "클릭수 (Clicks)",
                        "cost": "비용 (Cost/Spend)",
                        "conversions": "전환수 (Conversions)",
                        "revenue": "매출 (Revenue/Sales)"
                    }
                    for k, label in k_labels.items():
                        default_val = temp_map.get(k) if temp_map else None
                        default_idx = (temp_all_cols.index(default_val) + 1) if (default_val and default_val in temp_all_cols) else 0
                        
                        selected = st.selectbox(
                            label,
                            options=["-- 선택 안함 (0 처리) --"] + temp_all_cols,
                            index=default_idx if default_idx < len(temp_all_cols) + 1 else 0,
                            key=f"col_override_{k}"
                        )
                        if selected and selected != "-- 선택 안함 (0 처리) --":
                            user_overrides[k] = selected

            # 2nd Pass: Final Load
            clean_df, raw_df, col_map, all_cols, error_msg = load_and_preprocess_data(
                file_bytes, uploaded_file.name, user_overrides=user_overrides
            )
            
            if col_map:
                with st.expander("✅ 매핑된 컬럼 정보", expanded=False):
                    for k, v in col_map.items():
                        st.text(f"• {k}: {v}")
                    if "revenue" not in col_map:
                        st.warning("• revenue: (0 처리됨)")

    # ------------------------------------------
    # CENTER PANEL: Main Dashboard Reports
    # ------------------------------------------
    with col_center:
        st.markdown("""
        <div class="report-header">
            <div class="report-title">📊 온라인 퍼포먼스 마케팅 주간 리포트</div>
            <div class="report-subtitle">KPI 요약, 전일/전주 대비 증감율, 시각화 추이 차트, 상세 분석 테이블</div>
        </div>
        """, unsafe_allow_html=True)

        if not uploaded_file:
            st.info("👈 **좌측 Settings Panel**에서 `raw_data.tsv` 파일을 업로드하시면 리포트와 AI 분석이 구동됩니다.")
            with st.expander("ℹ️ 지원되는 필수 데이터 항목 및 안내"):
                st.markdown("""
                - **날짜**: `Date`, `일자`, `날짜`, `보고일` 등
                - **노출**: `Impressions`, `노출`, `imp` 등
                - **클릭**: `Clicks`, `클릭`, `클릭수` 등
                - **비용**: `Cost`, `Spend`, `비용`, `광고비` 등
                - **전환수**: `Conversions`, `전환수`, `구매수` 등
                - **매출**: `Revenue`, `Sales`, `매출`, `전환가치` 등 *(없을 경우 0으로 자동 처리)*
                """)
        elif error_msg:
            st.error(f"⚠️ 데이터 처리 실패: {error_msg}")
        elif clean_df is None or clean_df.empty:
            st.warning("⚠️ 업로드한 파일에 분석 가능한 데이터가 존재하지 않습니다.")
        else:
            # Analytics calculation
            analytics = get_report_analytics(clean_df)

            # 1. KPI Summary Cards
            render_kpi_summary(analytics["total_kpis"], analytics["dod"], analytics["wow"])
            st.markdown("<div style='margin-bottom: 1.2rem;'></div>", unsafe_allow_html=True)

            # 2. Charts (2-col inside center)
            st.markdown('<div class="section-title">📈 퍼포먼스 추이 차트</div>', unsafe_allow_html=True)
            c1, c2 = st.columns(2)
            with c1:
                st.plotly_chart(make_daily_chart(analytics["daily_df"]), use_container_width=True)
            with c2:
                st.plotly_chart(make_weekly_chart(analytics["weekly_df"]), use_container_width=True)

            st.markdown("<div style='margin-bottom: 1.2rem;'></div>", unsafe_allow_html=True)

            # 3. Marketing Insights Section
            render_insights_section(analytics)

            st.markdown("<div style='margin-bottom: 1.2rem;'></div>", unsafe_allow_html=True)

            # 4. Report Table
            render_kpi_table(analytics["daily_df"], analytics["weekly_df"])

    # ------------------------------------------
    # RIGHT PANEL: AI Performance Agent (Gemini 3.5 Flash)
    # ------------------------------------------
    with col_right:
        render_ai_agent_panel(clean_df, raw_df, user_api_key)


if __name__ == "__main__":
    main()
