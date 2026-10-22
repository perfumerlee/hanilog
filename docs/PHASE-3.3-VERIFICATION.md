# HaniLog — Phase 3.3 GitHub Integration & Realtime Security

**판정: CONDITIONAL GO**  
**로컬 DB:** Phase 3.3 migration 적용, pgTAP 44/44, 동시성 및 Realtime 철회 회귀 통과  
**GitHub Actions:** workflow 준비 완료, 실제 원격 실행 미검증  
**외부 변경:** 원격 저장소 미생성, push 미수행, 운영 배포 없음

## 1. Git 저장소 준비 및 개인정보 점검

- Git `2.55.0.windows.3` 확인. 작업 디렉터리에 Git 저장소가 없어 `git init`으로 로컬 저장소를 초기화했다. 아직 commit이나 remote는 없다. 기본 branch는 `master`이고, 실행 환경이 `.git/HEAD.lock` 작성을 거부해 `main`으로 rename하지 못했다. branch 이름은 원격 저장소 준비 시 정리할 수 있다.
- `.gitignore`에 `.supabase-cli-home/`, `.env*`(단 `.env.example` 제외), 로컬 DB/SQLite, WSL VHDX, 로그, 로컬 TLS key/certificate, 테스트 산출물을 추가했다. 무시 규칙을 `git check-ignore`로 확인했다.
- 사용자별 반려동물 건강 맥락이 들어 있는 `docs/PRD.md`, `docs/SAFETY-CONTRACT.md`, `docs/IMPLEMENTATION-ROADMAP.md`, `docs/PHASE-0.5-AUDIT.md`는 `.gitignore`로 제외했다. 파일은 로컬에 그대로 남아 있으며, source control에 넣으려면 일반 사례로 비식별화해야 한다.
- 비밀키/JWT 값 패턴 검사 결과 실제 credential value 패턴은 발견되지 않았다. `.env.example`에는 빈 공개 설정 변수만 있다. `.supabase-cli-home`, `node_modules`, `dist`, 로컬 DB 파일, 로그 파일은 commit 대상에서 제외된다.
- 테스트 fixture는 `@example.test` 계정, 합성 이름/값으로만 구성된다. 실제 의료 기록을 포함하지 않는다.
- GitHub 연결 도구 인증 계정은 `perfumerlee`로 확인했다. 로컬 `gh` CLI는 설치되지 않았다. 해당 계정의 `hanilog` 저장소 검색 결과는 없었다. 비슷한 이름의 타인 저장소는 사용하지 않았다. 사용자가 요구한 승인 게이트에 따라 원격 생성 및 push는 하지 않았다.

## 2. GitHub Actions 구성

- `.github/workflows/ci.yml`은 Ubuntu runner에서 `npm ci`, TypeScript typecheck, ESLint, Vitest, production build, 비루트 Pages 하위 경로 build를 수행한다.
- `.github/workflows/database-tests.yml`은 `ubuntu-24.04`, Supabase CLI **2.121.0**으로 고정되어 있다. 새로운 job-local Supabase stack에서 migrations를 적용하고 pgTAP, 두 PostgreSQL 세션 concurrency test, 독립 Auth 사용자 Realtime 철회 test를 실행한다. `supabase link`, 운영 project ref, service key, 배포 작업은 없다. Actions step의 Realtime 연결에는 로컬 URL과 공개 publishable key만 쓴다.
- Ubuntu 24.04 GitHub-hosted runner 이미지 목록에 PowerShell 7이 포함되어 있어 현재 `run-concurrency-test.mjs`의 POSIX `pwsh` 실행 경로와 호환된다. [공식 runner 이미지 목록](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)
- 저장소가 원격에 없고 실행 승인을 받지 않았으므로 **GitHub Actions 자체 실행 결과는 없음**. 아래 결과는 Windows 로컬에서 동등한 script/CLI를 실행한 결과이며 원격 workflow의 통과로 간주하지 않는다.

## 3. Realtime 권한 설계

- 새 migration `202610220002_phase33_private_realtime_invalidation.sql`은 `hanilog.pet.<uuid>`, `hanilog.household.<uuid>`, `hanilog.user.<auth.uid>` private channel용 `realtime.messages` SELECT RLS를 추가한다. Pet topic은 현재 membership 및 Pet grant를, Household topic은 활성 membership을, user topic은 로그인 사용자와 UUID 일치를 확인한다. 클라이언트의 Broadcast write policy는 없다.
- Health Event, Revision, Routine Occurrence, Safety Evaluation 변경은 DB trigger에서 Pet 채널로 `{ "kind": "invalidate" }`만 보낸다. 의료 행·event ID·측정값·메모·시각은 payload에 넣지 않는다. Supabase Realtime transport가 수신 payload에 자체 메시지 `id`를 추가하는 것을 확인했고, 이는 기록 ID가 아닌 전송 메시지 ID다. 임상 테이블은 `supabase_realtime` Postgres Changes publication에서 제거했다.
- grant/membership 변경은 Pet 채널에만 의존하지 않고 별도 본인 topic으로 `{ "kind": "access_changed" }`를 보낸다. Households 쪽에는 일반 무정보성 invalidate를 보낸다. Realtime 발송 실패가 기록 트랜잭션을 실패시키지 않도록 trigger helper는 전송 예외를 억제한다. 이 경우 최신 상태는 API 재조회/연결 상태로 판단한다.
- UI는 세션 token을 Realtime에 반영하고, 권한 변경 메시지 수신 시 React의 Pet/건강기록/루틴 상태와 대기 명령을 즉시 비운다. 선택 Pet을 해제해 기존 Pet 채널을 정리하고, token refresh 후 서버에서 Pet 권한을 다시 조회한다. offline event 때는 Dashboard와 Care Routine의 기존 건강기록을 숨기고 `UNVERIFIED`를 표시한다. 연결이 다시 성립되면 서버 조회를 수행한다.

## 4. 로컬 검증 환경 및 결과

- Docker Engine `29.9.1`, Linux mode. Supabase CLI `2.121.0`. DB, Auth, REST, Realtime, Storage, Kong, Studio, Inbucket, pg-meta 등 핵심 컨테이너가 실행 중이었다. Vector, Analytics/Logflare, imgproxy, Edge Runtime, pooler는 기존 설정대로 제외/정지 상태였다.
- 기존 로컬 DB는 reset하지 않았다. 적용 전 합성 데이터는 Household 3, Pet 4, Health Event 14였다. `202610220002` 적용 후 정정 이력 trigger가 실제 revision schema에 없는 `pet_id` 열을 읽으려는 결함을 발견했다. 기존 migration은 바꾸지 않고 `202610220003_phase33_revision_invalidation_fix.sql` 후속 migration으로 부모 Health Event에서 Pet을 찾도록 수정했다. 최종 migration 목록 `202610210001`, `202610210002`, `202610220001`, `202610220002`, `202610220003`이 모두 적용됨을 확인했다.
- pgTAP: 3개 파일, **45/45 통과**. 새 `realtime_security.test.sql`은 사용자 topic 위장 방지, grant 없는 Pet 차단, Household membership, SELECT-only channel policy, clinical publication 제외, revision insert 경로를 검증한다.
- `npm run test:db:concurrency`: **통과**. 독립 PostgreSQL backend PID 2890 및 2903, 동일 occurrence advisory lock 대기를 확인했다. 서로 다른 실제 이벤트 2건, `DUPLICATE_POSSIBLE`, event/audit/evaluation 보존, 동일 멱등 키 재시도 무추가 저장, 철회 이후 write/RLS 차단이 확인됐다.
- `npm run test:db:realtime`: **통과**. 보호자 B의 다른 Pet channel 가입 거부, 의료 데이터 없는 generic invalidation 수신, 별도 user-topic 철회 신호 및 cache-clearing callback, 철회 후 API read 0건 및 RPC write 거부, JWT 갱신 후 Pet channel 재가입 거부, 타 Pet event 격리를 확인했다. 테스트 fixture cleanup도 통과했다.
- Health Event 정정 RPC까지 실제 Realtime test에 포함해 revision trigger가 같은 무정보성 Pet invalidation을 내보냄을 확인했다.
- **중요 관찰:** 권한 철회 후 이미 연결된 B의 Pet channel에서 새 invalidation이 추가로 수신됐다. 이는 Supabase Realtime이 채널 연결 수명 동안 권한 판단을 캐시할 수 있다는 공식 문서와 일치한다. 수신 메시지는 generic invalidation과 transport message ID뿐이었다. 건강 이벤트는 전달되지 않았고 서버 조회/쓰기는 차단됐다. 별도 `user:<id>` 철회 알림으로 클라이언트가 해당 채널을 닫고 비공개 상태를 비우는 것을 구현했다. [Realtime Authorization 문서](https://supabase.com/docs/guides/realtime/authorization)
- 기존 합성 DB 수는 테스트 후에도 Household 3, Pet 4, Health Event 14였고 `phase33-realtime-*@example.test` 임시 계정은 0건이었다.

## 5. 프런트엔드 회귀

- `npm run typecheck` — 통과.
- `npm run lint` — 통과.
- `npm test` — 4개 파일, 19/19 통과.
- `PAGES_BASE_PATH=/hanilog/ npm run build` — 통과. Vite production/PWA 산출 완료.
- Realtime 검증은 실제 local Supabase Auth/Realtime API를 사용하는 Node 통합 스크립트였다. **실제 브라우저에서 두 개의 UI 세션을 조작하는 E2E 테스트는 실행하지 않았다.** 브라우저 상태 정리 코드는 구현했지만 React 화면의 렌더/구독 종료는 브라우저 E2E로 추가 확인해야 한다.

## 6. 수정 파일

- 추가: `supabase/migrations/202610220002_phase33_private_realtime_invalidation.sql`, `supabase/migrations/202610220003_phase33_revision_invalidation_fix.sql`
- 추가: `supabase/tests/realtime_security.test.sql`
- 추가: `src/lib/realtime.ts`
- 수정: `src/ui/App.tsx`, `src/ui/CareRoutinePage.tsx`, `src/ui/SharedCarePage.tsx`
- 수정: `.gitignore`, `.github/workflows/database-tests.yml` (`ubuntu-24.04` 고정), `docs/ARCHITECTURE.md`, `docs/ACCESS-CONTROL.md`
- 수정: `scripts/test-realtime.mjs` — Phase 3.3 private Broadcast, revoke, RLS/API, JWT 재가입, 타 Pet 격리 검증으로 교체
- 추가: 본 보고서

## 7. 남은 위험 및 Phase 4 조건

1. Supabase Realtime authorization cache는 기존 연결에서 철회 직후까지 stale할 수 있다. 테스트에서도 그런 동작을 재현했다. 무정보성 payload와 현재 서버 권한을 확인하는 API/RPC가 보안 경계이며, 브라우저 캐시 정리의 실제 UI 동작은 E2E 검증이 남았다.
2. offline 또는 Realtime 장애 중에는 user-topic 철회 신호를 받을 수 없다. 앱은 오프라인 때 표시 데이터를 비우고, 재연결 후 RLS/API로 재검증한다. 운영 환경에서 JWT 수명, Realtime public-channel 허용 해제, rate/connection 설정을 별도로 검토·확정해야 한다. 현재 migration은 프로젝트 전역의 “Allow public access” dashboard setting을 변경하지 않는다.
3. GitHub Actions 실제 run은 아직 없다. Phase 4의 시작 gate로 로컬 검증뿐 아니라 원격 private repository에서 두 workflow의 실제 실행 통과를 확인해야 한다.
4. 계정 소유가 확인된 GitHub connector는 인증 상태였지만 remote 생성/push 승인은 당시 받지 않았다. 사용자별 건강 맥락이 포함된 네 개 설계 문서는 Git에서 제외했다.

**Phase 3.3: CONDITIONAL GO.** DB migration, RLS, 동시성, stale Realtime channel의 정보 노출 제한, 철회 알림 및 로컬 UI 회귀 검증은 통과했다. **Phase 4: CONDITIONAL GO** — 비공개 `hanilog` 저장소 push, GitHub Actions 두 workflow의 실제 통과, 브라우저 E2E cache-clear 확인 후 진행한다. 운영 Supabase 연결·Pages 공개 배포는 수행하지 않았다.

## 8. 2026-10-22 저장소 연결 후속 확인

- 사용자가 `perfumerlee/hanilog` 비공개 저장소 생성 및 초기 push를 승인했다. 승인에 따라 로컬 첫 커밋을 `main`에 만들었으며, 본문 파일에서 반려동물 이름을 이용한 루틴 예시를 일반 문구로 바꿨다. 네 개의 사용자별 건강 맥락 문서는 계속 제외했다.
- 업로드 후보 최종 확인에서 `.env.example` 외 비밀키 파일, 로컬 DB, 로그, WSL 디스크는 추적되지 않았다. workflow에는 GitHub Pages 배포 단계가 없다.
- 연결된 GitHub 도구는 저장소 목록 조회는 지원하지만 새 저장소 생성 API를 제공하지 않는다. 로컬 Git Credential Manager에서도 비대화형 GitHub 자격 증명을 찾지 못했고 `gh` CLI도 없다. 따라서 원격 저장소 생성·push는 아직 실행되지 않았으며 GitHub Actions run도 생성되지 않았다. 이는 사용자 승인이 부족해서가 아니라 현재 세션의 GitHub 쓰기 수단이 없기 때문이다.
- 같은 작업 시점의 로컬 프런트엔드 회귀: typecheck, lint, Vitest 4개 파일/19개 테스트, 기본 build, `PAGES_BASE_PATH=__pages_subpath_test__` build 모두 통과했다. 이 결과는 GitHub Actions 실행 결과가 아니다.
- 로컬 Supabase CLI status는 샌드박스가 `%USERPROFILE%\\.supabase` 폴더 생성을 차단해 확인하지 못했다. 이 후속 작업에서 DB/pgTAP, 동시성, Realtime 검증을 재실행하지 않았으며 이전 섹션의 Phase 3.3 로컬 결과와 구분한다.
- 저장소 URL과 원격 CI 결과는 미확정이다. GitHub에 저장소를 생성할 수 있는 연결 또는 GitHub CLI 인증이 제공된 뒤 `main` push와 두 workflow 실행이 필요하다. Pages 배포는 비활성 상태로 유지한다.
