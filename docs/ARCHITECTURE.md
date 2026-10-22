# Pet Health Log — Architecture

## 1. 시스템 구성

```text
React + TypeScript + Vite PWA
  ├─ Auth UI, Household/Pet UI, event forms, daily timeline
  ├─ connection / evaluation status
  └─ optional local draft store (not server-confirmed)
          │ HTTPS + user JWT + publishable key
          ▼
PostgreSQL (source of truth)
  ├─ RLS + least-privilege grants
  ├─ household membership + pet-specific grants
  ├─ plan/routine versions + occurrences + health events/revisions
  ├─ idempotency + audit + safety evaluations
  └─ future notification outbox (not first-MVP delivery feature)
          │
          └── Supabase Auth / Realtime refresh hints
```

**기본 스택 제안:** React + TypeScript + Vite PWA, Supabase Auth, PostgreSQL. DB migration, 권한, event 명령을 재현 가능하게 관리합니다. Realtime은 화면 갱신 신호일 뿐 정합성 보장 수단이 아닙니다. Storage, external notification provider, clinician portal은 초기 MVP에서 사용하지 않습니다.

## 2. 클라이언트와 서버 책임

### 클라이언트

- 입력 폼과 유효성 피드백, 발생 시각 입력·시간대 표시, 일별 타임라인.
- 멱등성 키 생성 후 같은 논리 명령 재시도 동안 재사용.
- 응답된 Safety Evaluation 내부 코드를 별도 사용자 문구로 렌더.
- 연결 단절 시 즉시 `UNVERIFIED` UI를 표시하고 최신 조회·평가가 불가함을 알림.
- 오프라인 초안 저장은 optional/later. 저장 시 `PENDING_SYNC`로 로컬에만 표시. 캐시만으로 현재 안전평가를 표시하지 않음.
- 클라이언트 권한 UI는 UX 보조일 뿐 접근통제가 아님.

### 서버/DB

- 요청마다 Auth actor, 현재 Household membership, Pet-specific grant/care-team link 확인.
- PostgreSQL RLS와 최소 grants 적용. 중요 명령에서도 actor/pet 관계를 재검증.
- UTC `recorded_at` 부여 및 `occurred_at` 정규화/입력 provenance 보존.
- plan/routine/occurrence 연결과 승인 상태 확인.
- 임상 중요 event create/revision/void, idempotency, audit, safety evaluation 근거를 트랜잭션으로 처리.
- 앱은 임상 적정성 승인·용량 계산을 하지 않습니다.

비밀/service key는 클라이언트에 노출하지 않습니다. Supabase Edge Function이 사용자 요청 경계가 되면 사용자 JWT를 전달하고 RLS를 존중하거나 명령 실행 전 서버에서 현재 권한을 검증합니다.

## 3. 데이터 흐름 및 트랜잭션 경계

### 3.1 Health Event 생성

1. 클라이언트가 event UUID, idempotency key, request fields, `occurred_at`, optional occurrence ID를 제출합니다.
2. 서버가 인증과 활성 membership 및 Pet grant를 검사합니다. 의료진은 승인된 link scope가 필요합니다.
3. DB transaction에서 `(actor, operation, key)`와 request hash 확인. 동일 요청은 저장된 기존 결과 반환, 같은 key의 다른 body는 conflict.
4. 새 요청이면 occurrence ID가 있다면 pet/routine/plan version 관계 및 상태 확인 후 occurrence-scoped lock 획득.
5. 잠금 후 최신 관련 event/revision을 다시 읽습니다. event를 append하고 server `recorded_at`을 지정합니다.
6. 데이터 관계를 평가합니다. 동일 슬롯 투약 기록이 있으면 `DUPLICATE_POSSIBLE`; 둘 이상의 실제 event를 모두 보존.
7. event, idempotency result, safety evaluation/evidence, audit row를 원자적으로 commit.
8. 반환 응답에는 event ID, 서버 기록 시각, evaluation status/result codes, evaluated_at이 포함됩니다.

DB commit 이후 응답이 끊긴 경우 동일 idempotency key 재시도는 기존 결과를 반환합니다. 멱등성은 네트워크 재전송으로 인한 중복을 방지하며 두 보호자의 서로 다른 실제 입력을 합치지 않습니다.

### 3.2 정정/무효화

revision 명령은 현재 권한과 대상 event 접근을 재검증하고 기대 revision/version을 비교합니다. 정정 또는 void를 새 immutable revision으로 저장하며 기존 event/revisions를 지우지 않습니다. 연결된 평가를 `STALE` 처리하고 새 evaluation을 생성할 수 있습니다. 개인정보 삭제 요청은 별도 서비스 절차이며 revision과 혼합하지 않습니다.

### 3.3 권한 철회

Membership 또는 Pet grant revoke는 권한 행 변경과 audit를 같은 transaction에 기록합니다. 이후 서버 요청/RLS/Realtime 구독은 현재 DB 상태로 차단합니다. 서비스 캐시/연결 구독은 권한 철회를 신속히 재평가하되 최종 차단은 서버/DB가 담당합니다.

### 3.4 Care Plan 변경

새 plan/routine version은 기존 version을 수정하지 않고 생성합니다. 수행 event가 연결된 occurrence는 보존합니다. 영향을 받는 미수행 미래 occurrence 처리 정책에 따라 이전 슬롯을 `SUPERSEDED/CANCELLED`로 보존하고 새 version 슬롯을 생성합니다. 배포 가능한 정확한 유효 시각과 임상 효력은 의료진/제품 계약에 따릅니다.

## 4. Safety Evaluation

서버 입력은 현재 권한, Pet, occurrence, plan/routine versions, 최신 유효 event/revision을 포함합니다. Evaluation 상태는 `CURRENT`, `STALE`, `UNAVAILABLE`, `NOT_APPLICABLE`; 결과 코드는 `PRECONDITION_UNCONFIRMED`, `MEAL_UNCONFIRMED`, `MEAL_EXCEPTION_REPORTED`, `DUPLICATE_POSSIBLE`, `PLAN_UNVERIFIED`, `CLINICIAN_GUIDANCE_UNAVAILABLE` 등을 사용합니다. 승인 확인되지 않은 개인 routine도 명시적 occurrence의 비의료 중복 가능성·기록 미확인 계산에는 사용할 수 있지만 임상 조건·지침 판단에는 사용하지 않습니다.

승인 확인되지 않은 plan/routine은 개인 일정으로 표시합니다. Safety Guard는 일정 슬롯의 데이터 관계(예: 동일 슬롯 기록 존재)는 표시할 수 있지만 임상 판단의 근거로 삼지 않습니다. 실제 행위 event는 경고와 무관하게 저장합니다. 인프라 오류/연결 불가 시 payload 없이 API `UNAVAILABLE`, 화면 `UNVERIFIED`; 권한 거부 시 401/403과 데이터 미반환입니다.

## 5. 실시간 동기화

- 클라이언트는 `hanilog.pet.<uuid>`, `hanilog.household.<uuid>`, `hanilog.user.<auth.uid>` 형식의 private Broadcast 채널만 사용합니다. `realtime.messages` SELECT RLS는 현재 Pet grant, Household membership 또는 본인 user topic을 확인합니다. 클라이언트 Broadcast INSERT 정책은 두지 않습니다.
- PostgreSQL은 이벤트/루틴/평가 변경 후 `{ "kind": "invalidate" }`만 해당 Pet topic으로 보냅니다. 의료 행, Pet/event 식별자, 수치, 메모, 시각은 payload에 포함하지 않습니다. 임상 테이블은 Postgres Changes publication에서 제외합니다.
- Pet·권한 재조회 및 기록 상태 확인은 API/RPC에서 현재 RLS와 권한 검증을 거칩니다. Broadcast 수신만으로 데이터 상태나 투약 사실을 확정하지 않습니다.
- 권한 변경은 별도의 수신자 전용 `hanilog.user.<user_id>` 채널에 `access_changed`를 보냅니다. Pet topic이 이미 수립된 연결에서 권한 캐시를 유지할 수 있으므로 철회 전용 신호를 Pet topic에만 의존하지 않습니다. 클라이언트는 수신 즉시 비공개 메모리 상태를 비우고 Pet 구독을 제거한 뒤 세션 토큰을 갱신하고 Pet 목록을 서버에서 다시 조회합니다.
- Realtime 권한은 구독 및 새 JWT 전달 때 평가됩니다. 연결이 끊긴 동안에는 철회 신호를 받을 수 없으므로 화면에 최신 상태를 표시하지 않으며, 포커스/재연결 후 현재 서버 권한을 재조회합니다. 기존 topic의 권한 캐시를 제거할 수 없는 경우에도 payload가 무정보성 힌트뿐이라야 합니다.
- 운영 Supabase 프로젝트에서 public channel 허용을 끄고 private-channel 정책을 강제해야 합니다. 이 설정은 이 저장소의 SQL만으로 배포되지 않으므로 별도 운영 설정 승인·검증 전에는 운영 데이터 연결을 금지합니다.

## 6. Notifications Worker 정책

첫 MVP에는 email/Web Push worker를 포함하지 않습니다. 인앱 타임라인이 현재 서버 상태를 표시합니다. 후속 outbox 설계는 다음 계약을 사용합니다.

- 업무 트랜잭션과 같은 transaction에서 outbox enqueue.
- key는 source event/revision + recipient + channel + notification type + template version의 안정된 조합.
- worker claim은 lease/attempt로 원자화하고 공급자 네트워크 호출은 DB transaction 밖에서 수행.
- 전송 전에 현재 recipient membership/Pet grant와 notification preference를 재검증. 철회된 수신자의 대기 알림은 suppress.
- transient 429/5xx/timeout 재시도는 제한·지수 backoff/jitter, 영구 오류는 failed 및 endpoint 조치.
- provider timeout은 수신 여부 불명일 수 있으므로 end-to-end exactly-once를 보장하지 않음. 앱 내부 enqueue/delivery ID는 멱등하게 관리하고 재시도 결과를 추적.
- 알림 payload는 민감 의료 상세를 최소화. queued/sent/delivered(if known)/read/action은 각각 다른 상태.

## 7. 시간 처리

DB는 순간 시각을 UTC로 보존합니다. `occurred_at`과 server-generated `recorded_at`은 분리합니다. 반복 일정은 IANA timezone, local date/time, DST disambiguation, resolved UTC instant를 함께 저장합니다. 기본 표시 시간대는 Pet timezone이며, 사용자의 locale/timezone으로 전환할 때 화면에 시간대를 표시합니다. 사용자/Pet timezone 변경은 과거 event를 변경하지 않고 향후 occurrence에만 적용합니다.

## 8. 장애·복구 및 미확정 운영정책

- DB/API 장애: 최신 안전 확인을 할 수 없음을 표시. 초안 기능이 꺼져 있으면 서버 기록 실패를 명시하고 재시도 유도.
- Realtime 장애: 상태 재조회.
- 권한 철회: 이전 JWT/캐시를 승인하지 않고 현재 권한 재검증.
- provider 장애: 후속 worker에서 outbox 유지와 제한 재시도.
- DB와 Storage 백업은 분리; Storage는 MVP 미포함.
- 개인정보 보존기간, 데이터 처리 지역, 백업 보존기간 및 RPO/RTO는 미확정. 실제 사용자 데이터 수집·파일럿 전에 책임자 승인과 복구 운영계획이 필요합니다. 자세한 미확정 관리표는 `IMPLEMENTATION-ROADMAP.md §5`.

## 9. 자체 호스팅 고려

PostgreSQL migration과 합성 seed를 재현 가능하게 두고 공급자 연계는 adapter 경계에 둡니다. Supabase Auth/RLS/Realtime을 사용하면 이식성 및 자체 운영 부담이 생깁니다. Supabase self-hosting의 OS 보안, secret, PostgreSQL 유지보수, 백업·복구·모니터링 책임은 운영 주체가 가집니다. 자체 호스팅 release는 MVP 이후 단계입니다.

## 10. GitHub Pages 배포 계약

### 10.1 역할과 공개 설정

- GitHub Pages는 정적 HTML/CSS/JS와 PWA shell만 제공하며 인증이나 권한 검증을 하지 않습니다. 사용자 데이터의 최종 저장·접근통제는 Supabase Auth/PostgreSQL/RLS와 서버 명령이 담당합니다.
- 브라우저 번들에 포함되는 값은 공개 정보입니다. `VITE_SUPABASE_URL`과 Supabase publishable key만 빌드 환경에 둘 수 있습니다. 이 값은 저장소 변수 또는 공개 빌드 설정으로 다루며 비밀로 간주하지 않습니다.
- Supabase secret/service-role key, DB 비밀번호, JWT signing secret, Edge Function secret, 이메일/Web Push 자격증명은 Vite `VITE_*` 변수, 저장소, Pages artifact, 브라우저 코드 및 Actions 로그에 두지 않습니다. 서버 비밀은 Supabase Edge Function secret store에만 둡니다.
- RLS가 활성화되고 최소권한 정책이 검증되기 전에는 공개 publishable key가 안전한 데이터 경계라고 간주하지 않습니다. Edge Function은 전달된 사용자 JWT와 현재 pet grant를 검증하며, 비밀키를 쓰는 경로도 actor·대상 범위를 서버에서 제한합니다.

### 10.2 Vite 하위 경로와 라우팅

- Project Pages URL의 앱 경로는 `/<repository>/`; 사용자/조직 Pages 또는 커스텀 도메인의 루트 배포 경로는 `/`입니다. 빌드의 Vite `base`는 대상 경로와 정확히 일치해야 하며, 개발 시 기본 루트와 Pages용 경로를 명시적으로 구분합니다.
- 기본 라우팅은 `HashRouter` 등 URL fragment를 사용하는 클라이언트 라우팅입니다. 예: `https://<owner>.github.io/<repository>/#/pets/<id>`. 서버에 없는 경로로 직접 요청하지 않으므로 새로고침 및 직접 URL 접근에서 Pages의 404를 피합니다. 라우트 생성, OAuth 복귀, 앱 링크를 모두 이 규칙으로 시험합니다.
- Path 기반 Router를 선택하려면 Pages의 커스텀 `404.html` 경로 복원 방식과 실제 호스팅 동작을 별도 검증해야 합니다. 이는 기본안이 아니며, 서버 rewrite가 있다고 가정하지 않습니다.
- GitHub Actions는 build 전에 Pages 배포 경로를 계산해 동일한 값으로 Vite `base`, 앱 link, manifest, worker asset 경로를 맞춰야 합니다. 빌드 아티팩트를 실제 repository subpath 아래에서 검사합니다.

### 10.3 PWA manifest, service worker, 캐시

- `manifest.webmanifest`의 `start_url`, `scope`, 아이콘과 service worker URL은 앱 배포 경로를 포함하도록 생성/검증합니다. Project Pages의 scope는 `/<repository>/` 아래로 한정합니다.
- Service worker는 같은 origin의 앱 하위 경로에 등록하고 앱 경로를 scope로 설정합니다. GitHub Pages에서 상위 경로로 scope를 확장할 수 있는 response header를 제공한다고 가정하지 않습니다.
- 캐시 범위는 정적 앱 shell, 해시된 정적 asset 및 명시적으로 공개된 문서에 한정합니다. Supabase Auth 응답, JWT, API/Realtime 응답, Pet/Household 건강기록은 Cache Storage 및 오프라인 최신 상태로 저장하지 않습니다. 오프라인 초안은 별도 후속 기능이며 로컬 pending으로만 취급하고 Safety Evaluation이나 서버 확정 timeline에 포함하지 않습니다.
- 업데이트 시 이전 worker/cache 제거와 새 버전 전환을 검증합니다. 로그아웃·계정 전환 시 민감한 메모리 상태를 비우며, 기록을 SW cache에 두지 않습니다.

### 10.4 GitHub Actions 배포 준비와 인증 경계

- 배포 구성은 별도 GitHub Actions workflow에서 build → `dist` Pages artifact 업로드 → `github-pages` environment 배포 단계로 설계합니다. 최소 `contents: read`, `pages: write`, `id-token: write` 권한과 공식 Pages artifact/deploy action을 사용하며 action 버전은 검토된 immutable revision으로 고정합니다.
- PR validation workflow와 배포 workflow를 분리합니다. PR에서는 build 및 정적 경로 검사만 하고, 배포는 승인된 branch/event와 `github-pages` environment protection을 통과할 때만 수행합니다. `dist`만 Pages artifact에 올리고 source map/불필요 파일 포함 여부를 검토합니다.
- GitHub Actions에는 비밀값이 필요하지 않아야 합니다. 공개 Supabase URL/publishable key는 repository variables 또는 workflow 입력으로 주입할 수 있고, 결과물에서 누구나 확인 가능함을 전제로 합니다. Supabase 비밀은 GitHub Pages에 전달하지 않습니다.
- Supabase Auth의 Site URL/redirect allowlist와 Edge Function CORS origin allowlist에는 정확한 Pages origin 및 앱 base 경로를 등록합니다. preview/PR URL은 기본 인증 callback으로 허용하지 않습니다. OAuth PKCE callback은 앱 base 진입점에서 처리하고 fragment route로 이동하는 end-to-end 동작을 검증합니다.
- 운영 배포, Pages 공개 활성화, Supabase redirect/CORS production allowlist 변경은 이 문서 작성 범위가 아닙니다. 현재 앱 소스와 package scripts가 마련된 뒤 workflow를 추가하고, 별도 운영 승인 후에만 Pages 배포를 실행합니다.

### 10.5 배포 전 검증 조건

- Project Pages 경로와 root/custom-domain 경로 각각에서 build asset, manifest, icon, worker 경로가 유효합니다.
- 로그인·로그아웃·OAuth callback, hash route 직접 접근/새로고침, 하위 경로에서의 PWA 설치·실행을 실제 preview origin에서 검증합니다.
- 브라우저 bundle과 artifact scan에서 secret/service-role key가 없고, RLS 통합 테스트가 통과합니다.
- worker가 API/Auth/건강기록을 캐시하지 않으며 오프라인에서 최신 Safety 상태를 `UNVERIFIED`로 표시합니다.
- Pages 배포 실패 시 이전 정적 릴리스가 남더라도 DB migration은 독립적으로 호환 가능한 순서로 진행하고, 앱 rollback이 데이터 schema rollback을 자동으로 의미하지 않도록 합니다.

### 참고 문서

- [Vite static deployment](https://vite.dev/guide/static-deploy.html), [Vite `base` option](https://vite.dev/config/shared-options#base)
- [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages), [custom 404 pages](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-custom-404-page-for-your-github-pages-site)
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys), [securing data](https://supabase.com/docs/guides/database/secure-data)
- [MDN service worker registration scope](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register), [manifest `start_url`](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/start_url), [manifest `scope`](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/scope)

