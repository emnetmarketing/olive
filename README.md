# 네쇼검 트렌드 모니터

기존 정적 HTML 대시보드를 참고해 새로 작성한 Streamlit 앱입니다. Supabase Auth와 Row Level Security를 사용하며, 계정·권한·공용 설정·분석 결과는 여러 PC와 브라우저에서 동일하게 복원됩니다.

기존 Netlify 운영 파일은 프로젝트 루트에 그대로 유지했습니다. `legacy/`에도 동일한 복사본을 보관하므로 Streamlit 배포가 검증되기 전까지 기존 사이트에 영향을 주지 않습니다.

## 주요 구조

```text
app.py                         Streamlit 메인 대시보드
pages/2_settings.py            공용 설정과 보관 정책
pages/3_user_management.py     승인·권한 관리
components/                    로그인, 암호화 세션, UI
services/                      Supabase, 분석, 네이버 API
sql/supabase_schema.sql        DB 테이블, 함수, RLS, 마스터 제약
legacy/                        기존 운영 화면 복사본
tests/                         단위 테스트
```

## 1. Supabase 준비

1. Supabase 프로젝트를 생성합니다.
2. SQL Editor에서 `sql/supabase_schema.sql` 전체를 실행합니다.
3. Authentication → Providers에서 Email 로그인을 활성화합니다.
4. 필요에 따라 이메일 인증 여부와 Site URL을 설정합니다.
5. 앱에서 최초 사용자를 가입시킨 뒤 SQL Editor에서 그 사용자를 최초 마스터로 승인합니다.

```sql
select id, email from public.profiles;

update public.profiles
set role='master', status='approved', approved_at=now()
where email='huni@emnet.co.kr';
```

마스터는 승인된 상태로 최소 1명, 최대 2명까지 가능합니다. DB 트리거와 앱 검사가 마지막 마스터의 강등·비활성화·삭제 및 세 번째 마스터 지정을 차단합니다.

## 2. 로컬 실행

Python 3.11 이상을 권장합니다.

```powershell
python -m pip install -r requirements.txt
Copy-Item .streamlit/secrets.toml.example .streamlit/secrets.toml
python -m streamlit run app.py
```

`.streamlit/secrets.toml`에 실제 값을 입력합니다. 이 파일은 Git에서 제외됩니다.

`SESSION_ENCRYPTION_KEY` 생성 예시:

```powershell
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## 3. Secrets

필수 항목:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NAVER_CLIENT_ID`
- `NAVER_CLIENT_SECRET`
- `SESSION_ENCRYPTION_KEY`

일반 프로필 조회, 설정 저장, 결과 저장은 ANON_KEY와 로그인 사용자의 JWT를 사용하며 Supabase RLS의 적용을 받습니다. SERVICE_ROLE_KEY는 `services/admin_service.py` 안에서 사용자 승인, 권한 변경, 계정 삭제에만 사용됩니다.

로그인 access token과 refresh token은 `SESSION_ENCRYPTION_KEY`로 암호화된 쿠키에 저장됩니다. 원문 토큰과 비밀번호는 화면이나 로그에 출력하지 않습니다. 운영 중 암호화 키를 변경하면 기존 브라우저 세션은 만료되고 사용자는 다시 로그인해야 합니다.

## 4. Streamlit Community Cloud 배포

1. GitHub 저장소를 Streamlit Community Cloud에 연결합니다.
2. Main file path를 `app.py`로 지정합니다.
3. Python 버전은 3.11 또는 3.12를 선택합니다.
4. App settings → Secrets에 `.streamlit/secrets.toml.example`과 같은 형식으로 실제 값을 등록합니다.
5. Deploy를 실행합니다.

최초 연결 이후 연결된 GitHub 브랜치에 push하면 Community Cloud가 변경을 감지해 자동 재배포합니다. GitHub에 push하는 것만으로 최초 앱 연결이나 Secrets 등록까지 자동 수행되지는 않습니다.

## 5. 계정과 권한

- `master`: 사용자 승인·거절·비활성화·삭제, 권한 변경, 모든 기능
- `editor`: 공용 설정 변경, 분석과 API 호출
- `operator`: 설정 조회, 분석과 API 호출
- 신규 가입자는 `pending/operator`로 시작합니다.

Supabase Auth가 비밀번호를 관리하며 애플리케이션 테이블에는 비밀번호를 저장하지 않습니다.

## 6. 분석 결과 보관

기본 보관 정책은 90일 또는 최대 1,000건입니다. 둘 중 먼저 초과하는 결과가 정리됩니다. 편집자와 마스터가 설정 화면에서 다음 범위 안에서 변경할 수 있습니다.

- 보관 기간: 1~3,650일
- 최대 건수: 10~100,000건

새 분석 결과 저장 시 `cleanup_analysis_results` DB 함수가 보관 정책을 적용합니다. 장기간 분석 실행이 없는 환경에서는 Supabase Cron으로 같은 함수를 정기 호출할 수 있습니다.

## 7. 테스트

```powershell
python -m unittest discover -s tests -v
```

실제 Supabase와 네이버 API의 통합 검증에는 별도의 테스트 프로젝트와 API 인증값이 필요합니다. 테스트 인증값은 GitHub나 테스트 출력에 기록하지 마세요.
