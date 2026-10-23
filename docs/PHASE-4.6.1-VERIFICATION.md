# HaniLog — Phase 4.6.1 Health Trends Verification

**검증일:** 2026-10-24

**범위:** 기존 Phase 4.6 구현 검증 및 발견된 공개정보 노출 가능성 최소 수정
**최종 판정:** CONDITIONAL GO

## 1. 포트·개발 서버

- 현재 세션에서 4173, 4174, 4175, 5173, 5174, 5175의 TCP LISTEN 소유 프로세스는 조회되지 않았습니다. 사용자의 프로세스를 종료하지 않았습니다.
- Docker Desktop 실행 파일·프로세스도 현재 세션에서 발견되지 않았고, Linux Engine named pipe `dockerDesktopLinuxEngine`가 없어 DB 실행 환경은 정지 상태입니다.
- Demo Vite 서버를 strict port로 `127.0.0.1:4175`에 실행하도록 시도했습니다. Vite 출력 주소는 `https://127.0.0.1:4175/`, `https://localhost:4175/`였지만 이 환경의 브라우저는 `ERR_CONNECTION_TIMED_OUT`, HTTPS HEAD 요청도 8초 후 시간 초과를 반환했습니다. OS 포트 조회에서도 listener를 확인하지 못했습니다.
- 따라서 이 주소의 TLS handshake, 인증서 수락, 실제 페이지 응답은 검증되지 않았습니다. 다른 점유 포트 프로세스를 식별하거나 종료하지 않았습니다.

## 2. 화면별 시각 검증

실제 브라우저 렌더링과 스크린샷 검증은 localhost 접근 실패로 수행하지 못했습니다.

| 화면 크기 | 시각 검증 |
|---|---|
| 375 × 812 | 미검증 |
| 390 × 844 | 미검증 |
| 430 × 932 | 미검증 |
| 768 × 1024 | 미검증 |
| 1440 × 900 | 미검증 |

차트의 점 터치, 축 레이블 겹침, 가로 잘림, 하단 내비게이션·Safe Area 겹침, 스크롤 및 기간 선택 동작은 실제 화면에서 확인하지 않았습니다. DOM 테스트는 시각 레이아웃이나 포인터 타깃 크기를 검증하지 않습니다. 아래 측정 목록은 별도 키보드/포인터 선택 UI로 구현되어 있으나 기기상 사용성 검증은 남아 있습니다.

**사용자 PC 브라우저 체크리스트:**

1. 프로젝트 PowerShell에서 `npm.cmd run dev:demo -- --host 127.0.0.1 --port 4175 --strictPort`를 실행합니다.
2. 터미널에 URL이 표시되고 오류 없이 실행 중인지 확인한 뒤 `https://localhost:4175/`에 접속합니다. 인증서 경고가 표시되면 개발 전용 인증서인지 확인하고 운영 환경에서 사용하지 않습니다.
3. 개발자 도구의 Device Toolbar에서 위 5개 뷰포트를 각각 설정합니다.
4. `/trends`를 열어 7일·30일·90일·1년·전체를 바꾸고 점, 측정값 목록, 상세 선택, 날짜 간격, 가로 넘침과 하단 내비게이션을 확인합니다.
5. 합성 Demo 전용 화면임을 확인합니다. 기록 변경은 서버에 저장되지 않습니다.

## 3. 데이터 정확성 코드·단위 테스트 검토

- X 좌표 계산은 `occurred_at` UTC instant를 사용하고 샘플을 발생 시각·ID 순으로 정렬합니다. 점 사이를 연결하지 않고 보간값을 생성하지 않습니다.
- 동일 날짜와 동일 시각의 서로 다른 event ID는 각각 유지됩니다. RDB 기본 키 기준 이벤트 중복은 DB가 차단해야 하지만, 실제 DB 조회 결과는 이번 환경에서 검증하지 못했습니다.
- 가장 높은 `revision_no`의 revision patch를 이벤트에 적용하며 최신 `VOID`는 제외합니다. 원본 이벤트는 읽기 전용으로 유지하는 화면 흐름입니다.
- 서버 조회는 Pet ID로 필터링합니다. 타 Pet 격리는 Supabase RLS가 최종 보호해야 하지만 실제 DB에서는 재검증하지 못했습니다.
- 신규 혈당 입력과 추세 표시는 `mg/dL`로 고정되어 있습니다. 단위가 다르거나 누락된 기존 값은 변환하지 않고 제외 사유와 저장 단위를 표시하도록 구현되어 있습니다. 신규 DB insert 계약 migration 및 pgTAP은 존재하지만 이번에는 실행되지 않았습니다.
- 현지 날짜 및 월별 집계는 Pet IANA 시간대를 사용합니다. 테스트는 UTC→Asia/Seoul 날짜 경계를 포함합니다. 관련 식사·인슐린 이벤트는 날짜 후보 구간을 가져온 뒤 Pet 시간대로 재필터링합니다.
- 테스트에는 역순 입력, 당일 복수 및 동일 시각 측정, 90일 데이터, 15일 간격, 월 1회, 3개월 초과 공백, 1,000건, VOID, correction, 비호환 단위가 포함됩니다. 중복 ID를 가진 응답을 별도 deduplicate하는 코드는 없으며 DB PK와 안정적 페이지 정렬에 의존합니다. 동시 데이터 추가 중 offset 페이지 조회의 완전성은 실제 통합 검증이 남아 있습니다.

## 4. 로컬 DB·보안 검증

- `docker info` — FAIL: Docker Desktop Linux Engine named pipe가 없습니다.
- `npx supabase status` — 미실행 완료: CLI가 사용자 프로필의 telemetry 임시 파일을 만들지 못해 `EPERM`으로 중단했습니다. 이를 우회하거나 사용자 프로필 파일을 변경하지 않았습니다.
- migration 적용, pgTAP, RLS/Pet 격리, 동시성·멱등성, Realtime 권한 회귀, Notifications Worker DB 검증 — 미검증. DB reset이나 데이터 삭제는 하지 않았습니다.
- 로컬에서는 DB 검증이 불가능했지만, GitHub Actions 격리형 Ubuntu runner가 새 로컬 Supabase 스택으로 migration과 아래 DB 검증을 성공적으로 실행했습니다. CI 결과를 로컬 DB 검증으로 간주하지 않습니다.
- C 여유 공간은 약 1.41 GB, E 여유 공간은 약 653.11 GB로 확인했습니다. Docker 저장 위치나 데이터 디스크 사용량은 Engine이 중지되어 확인하지 못했습니다.

## 5. 자동화 검증

| 검사 | 결과 |
|---|---|
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run lint` | PASS |
| `npm.cmd test` | PASS — 9 files, 38/38 tests |
| `npm.cmd run build` | PASS — Vite/PWA 산출물 생성 |
| `git diff --check` | PASS |
| GitHub Actions Build validation | PASS — [Run 39989146995](https://github.com/perfumerlee/hanilog/actions/runs/39989146995); typecheck, lint, Vitest, build, Pages 하위 경로 build 성공 |
| GitHub Actions Local database verification | PASS — [Run 39989146971](https://github.com/perfumerlee/hanilog/actions/runs/39989146971); Supabase startup, pgTAP/RLS, 두 세션 동시성, 2-user Realtime 권한 회귀, Mock Notifications Worker 성공 |

## 6. 공개 파일 점검 및 최소 수정

- 개인 건강 맥락이 포함된 설계 문서와 로컬 전용 Phase 5.0 readiness 문서는 공개 대상으로 두지 않습니다. `.gitignore`에 이미 제외된 네 문서를 유지하고, `docs/PHASE-5.0-READINESS.md`도 명시적으로 제외했습니다.
- `.env.demo`가 기존 예외 규칙으로 추적 가능했던 문제를 수정해 Git ignore 대상이 되도록 했습니다. 환경 파일 내용은 로그에 출력하지 않았습니다.
- Demo에 실제 반려견 이름이 예시 명칭으로 남아 있어 공개 식별 위험을 줄이도록 일반 합성 이름과 ID로 바꿨습니다.
- 선택 구현·문서 경로에서 민감정보 패턴을 점검했습니다. 프로젝트 이름과 일반 코드 용어가 검색에 걸릴 수 있으므로 이 검색 결과만으로 전체 Git 이력의 민감정보 부재를 보증하지 않습니다. 이전 공개 커밋 이력의 전수 비밀정보 스캔은 이번에 수행하지 않았습니다.
- `docs/PHASE-5.0-READINESS.md` 및 `.env.demo`는 로컬에 보존되며 staging/push 대상에서 제외해야 합니다.

## 7. 오류·수정 내역 및 남은 위험

수정한 것은 `.gitignore`의 `.env.demo` 예외 제거와 Phase 5.0 readiness 문서 제외, Demo 반려동물의 합성 표시명/ID 변경입니다. 그래프 계산 로직 변경은 하지 않았습니다.

남은 항목:

1. 실제 브라우저 localhost/TLS 접속 실패로 5개 뷰포트 시각 테스트 및 스크린샷 미확보.
2. Docker/Supabase 중지로 로컬 migration 및 DB 검증 불가. CI의 독립적인 로컬 Supabase DB 검증은 통과했으나 로컬 데이터/환경 상태를 대체하지 않습니다.
3. GitHub Actions 검증은 완료되어 두 workflow 모두 PASS입니다.
4. 점 터치 타깃, 같은 시각 점의 개별 선택, offset 기반 다중 페이지 조회의 동시 변경 시 누락 가능성을 브라우저·DB에서 확인해야 합니다.
5. 과거 공개 Git 이력 전체의 개인정보·비밀값 검사는 미완료.

## 8. Git 및 Phase 5.1 판정

일반 commit `e2147ffab7600a8235768ffcc4c5b6b0b6562cf9`을 `main`에 push했고 원격 최신 SHA가 같은지 확인했습니다. `.env.demo`, `docs/PHASE-5.0-READINESS.md`, 기존 개인 건강 관련 문서는 포함하지 않았습니다. Build validation 및 Local database verification 모두 실제 GitHub Actions에서 성공했습니다. 이 보고서의 최종 CI 상태를 반영하는 후속 일반 문서 commit이 추가되며, force push와 Pages 배포는 하지 않습니다.

**Phase 5.1 착수 판정: CONDITIONAL GO.** 로컬 및 GitHub Actions의 코드 검증과 CI DB/RLS·동시성·Realtime 검증은 통과했습니다. 실제 브라우저의 5개 뷰포트 시각 검증과 로컬 DB 검증, 공개 Git 전체 이력의 민감정보 전수 검사는 남아 있으므로 화면 사용성이나 실제 사용자 데이터 준비가 완료된 것으로 간주하지 않습니다.
