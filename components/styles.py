import streamlit as st


def apply_styles() -> None:
    st.markdown("""
    <style>
      .stApp { background: #f4f7f6; }
      [data-testid="stMetric"] { background:white; border:1px solid #dfe8e4; border-radius:14px; padding:16px; }
      [data-testid="stSidebar"] { background:#123d32; }
      [data-testid="stSidebar"] * { color:#f5fbf8; }
      .olive-title { font-size:2rem; font-weight:800; color:#123d32; margin-bottom:0; }
      .olive-subtitle { color:#668078; margin-bottom:1.2rem; }
      .role-chip { display:inline-block; padding:4px 10px; border-radius:999px; background:#dff4eb; color:#146c50; font-weight:700; }
      .status-card { background:white; border:1px solid #dfe8e4; border-radius:14px; padding:14px 18px; margin:8px 0; }
    </style>
    """, unsafe_allow_html=True)
