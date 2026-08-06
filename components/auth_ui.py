import streamlit as st

from components.auth import sign_in, sign_up


def render_login() -> None:
    st.markdown("## 네쇼검 트렌드 모니터")
    st.caption("Supabase 보안 로그인")
    login_tab, signup_tab = st.tabs(["로그인", "접근 신청"])
    with login_tab:
        with st.form("login_form"):
            email = st.text_input("이메일", key="login_email")
            password = st.text_input("비밀번호", type="password", key="login_password")
            submitted = st.form_submit_button("로그인", use_container_width=True)
        if submitted:
            try:
                profile = sign_in(email, password)
                if profile.approved:
                    st.rerun()
                else:
                    st.warning("계정 승인이 아직 완료되지 않았습니다.")
            except Exception:
                st.error("로그인에 실패했습니다. 계정 정보 또는 승인 상태를 확인하세요.")
    with signup_tab:
        with st.form("signup_form"):
            name = st.text_input("이름")
            email = st.text_input("이메일", key="signup_email")
            password = st.text_input("비밀번호 (8자 이상)", type="password", key="signup_password")
            password_confirm = st.text_input("비밀번호 확인", type="password")
            submitted = st.form_submit_button("접근 신청", use_container_width=True)
        if submitted:
            if len(password) < 8 or password != password_confirm:
                st.error("8자 이상의 동일한 비밀번호를 입력하세요.")
            else:
                try:
                    st.success(sign_up(email, password, name))
                except Exception:
                    st.error("가입 신청에 실패했습니다. 이미 등록된 이메일인지 확인하세요.")
