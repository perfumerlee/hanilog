# HaniLog — Phase 4 Notifications & PWA Implementation

**상태:** 구현 및 로컬 검증 완료. 외부 전달·운영 스케줄·실제 모바일 브라우저 검증은 미완료.

## 1. 구현 범위 및 알림 아키텍처

- 기존 Care Routine, Routine Occurrence, Health Event, Revision, Pet Grant/RLS와 Realtime 무효화 신호를 재사용합니다. 반복 일정과 건강기록 모델은 추가로 복제하지 않았습니다.
- 알림 생성, 노출 시각, 전송 대기, 전송 시도, provider acceptance, 알림 확인, 실제 케어 event는 별도 데이터 및 상태입니다. 알림 확인은 Health Event를 만들지 않습니다. `ACCEPTED`/`MOCK_ACCEPTED`는 provider 수준의 요청 수락일 뿐 수신자 기기의 표시·열람 증거가 아닙니다.
- 일정 생성·수정 및 Health Event와 알림/outbox 생성은 DB transaction/trigger 경계 안에서 처리합니다. 브라우저가 닫혀도 Edge Function Worker가 occurrence horizon과 사용자 설정 기반 기록 미확인 알림을 materialize하고 outbox를 처리하도록 구성했습니다.
- 공개 Push 본문과 이메일 본문은 일반적인 일정 안내입니다. Push payload는 알림 ID와 Pet ID만 포함합니다. 혈당, 약물명·용량, 메모, event 내용은 포함하지 않습니다.

## 2. Worker 및 Transactional Outbox

- `notification_outbox`는 `(notification_id, channel)`과 멱등 키를 고유하게 제한합니다. Worker는 `FOR UPDATE SKIP LOCKED`와 2분 lease로 최대 100건을 claim하고, DB transaction 밖에서 provider 호출을 수행합니다.
- 각 결과는 `notification_delivery_attempts`에 append-only로 보존하고 `audit_log`에는 최소 결과·오류 코드만 남깁니다. provider 응답 본문, endpoint, 인증 자격증명은 로그에 기록하지 않습니다.
- transient 오류는 제한된 exponential backoff+jitter로 재시도하고 attempt 제한/영구 오류에서는 `FAILED_PERMANENT`로 종료합니다. 만료, Pet grant 철회, 채널 설정 해제, 일정 취소·대체 시 대기 전송은 각각 `EXPIRED` 또는 `SUPPRESSED`가 됩니다.
- 전송 전 현재 Pet grant와 해당 채널 preference를 다시 확인합니다. provider 호출과 DB 사이에서 프로세스가 중단되면 Push 중복 가능성을 완전히 없앨 수 없으므로 at-least-once 특성이 남습니다. Resend에는 provider idempotency key를 전달합니다.
- Vault, `pg_cron`, `pg_net` 및 세 가지 HaniLog Vault secret이 모두 준비된 경우에만 migration이 1분 주기 Cron 호출을 등록합니다. 로컬 Vault secret이 없어 로컬/운영 Cron은 활성화하지 않았습니다. [Supabase scheduling 문서](https://supabase.com/docs/guides/functions/schedule-functions), [Supabase Cron 문서](https://supabase.com/docs/guides/cron)

## 3. Web Push

- 브라우저 endpoint 등록·목록·철회는 JWT를 검증하는 `manage-push-subscription` Edge Function과 본인 범위 RPC로 수행합니다. DB에는 endpoint, browser encryption keys, hash가 저장되지만 인증 사용자에게 직접 조회 권한을 주지 않습니다. 목록 RPC는 hash와 등록/만료/마지막 provider 성공 시각만 반환합니다.
- 기기별 활성 endpoint 상태를 표시하고 선택 endpoint를 철회할 수 있습니다. 현재 브라우저의 subscription을 해제할 때는 서버 철회가 확인된 후 Browser API 구독도 취소합니다. 404/410은 만료 endpoint로 처리해 비활성화합니다.
- Service Worker는 고정된 일반 문구를 표시하고 앱 하위 경로의 알림 화면으로 엽니다. Push handler asset은 Vite base-aware import로 구성했습니다. VAPID private key는 Edge Function secret, public key만 선택적 `VITE_VAPID_PUBLIC_KEY`로 전달합니다. [Web Push 라이브러리](https://jsr.io/@daaku/webpush/doc)
- 브라우저별 실제 전달은 테스트하지 않았습니다. 현재 공개 저장소에는 VAPID key가 없고, 실기기 등록·전달·만료 동작은 미검증입니다. JSR Web Push 구현은 현재 저사용량/신규 라이브러리이므로 운영 전 cryptographic/security review와 기기 간 interoperability 검증이 필요합니다.

## 4. 이메일 및 Mock Provider

- Worker는 `NOTIFICATION_DELIVERY_MODE=mock`을 기본값으로 사용합니다. mock 경로는 외부 network/provider를 부르지 않으며 Push와 이메일 각각 outbox/attempt/audit 상태를 기록합니다.
- `live` 이메일 경로는 인증된 Supabase Auth 이메일 주소, 서버 전용 `RESEND_API_KEY`, `RESEND_FROM`을 사용하고, 일반 안내 본문 및 Resend `Idempotency-Key`만 보냅니다. 이메일 본문에 임상 내용은 포함하지 않습니다. [Resend idempotency 문서](https://resend.com/changelog/idempotency-keys)
- mock integration에서 Push·Email 두 채널 모두 claim/accept 및 재호출 중 중복 억제를 확인했습니다. 실제 Resend 계정/API key/검증된 발신 도메인이 없어 외부 이메일 발송, 반송, provider 429/5xx는 검증하지 않았습니다.

## 5. 사용자별 알림 설정 및 확인 상태

- Pet/user/type별 in-app, Push, email, 일정 전 lead, 기록 미확인 지연·반복 간격, 방해금지 구간 및 Pet 시간대 설정을 제공합니다. 기본값은 in-app만 켜지고 외부 채널은 꺼집니다. 사용자가 지정하는 분 단위 값은 전달 선호이지 의료 임계값이 아닙니다.
- 계획 일정 알림, 기록 미확인 안내, 공동 보호자 기록 변경, 중복 가능성 확인, 루틴 변경을 구분합니다. 중복 알림은 중복 가능성 정보이며 의료적 투여 승인/판정이 아닙니다.
- 이벤트가 없을 때는 `기록 미확인`으로만 표시합니다. 실제 미실시로 추정하지 않습니다. 이미 발생한 케어의 사후 기록은 기존 Health Event RPC 계약을 따르며 알림 상태가 이를 막지 않습니다.
- 동일 Pet Realtime 무효화 신호를 받은 화면은 자체 RLS 조회로 알림을 다시 읽습니다. Realtime payload만으로 알림 또는 실제 수행을 확정하지 않습니다.

## 6. PWA 및 오프라인 경험

- Vite PWA의 기존 `GenerateSW`, `HashRouter`, manifest 및 Pages base 동작을 유지하고, custom Push handler와 base-aware service worker import를 추가했습니다.
- Android/Chromium `beforeinstallprompt`, iOS 공유 메뉴의 “홈 화면에 추가”, 설치 불가/미지원 안내, waiting Service Worker 업데이트 적용 상태를 추가했습니다.
- 오프라인 전환 시 in-memory 알림·설정·기기 목록을 비우고 `UNVERIFIED`를 표시합니다. 기존 Service Worker는 정적 asset만 precache하며 Supabase Auth/API/건강기록은 Cache Storage에 넣지 않습니다. 오프라인 draft나 마지막 서버 자료를 최신 상태로 표시하지 않습니다.
- `/hanilog/` build에서 worker import가 `/hanilog/push-handler.js`, manifest `scope`와 `start_url`이 `/hanilog/`인지 산출물로 검증했습니다. 실제 iOS/Android 기기, 설치 UX, Service Worker 업데이트 클릭은 미검증입니다.

## 7. DB migration, RLS 및 변경 파일

- 신규 migration 9개: `202610230001`~`202610230009`. 알림 선호·in-app/outbox/attempt/push subscription, RLS/RPC, schedule materialization 및 claim/retry, 기본 알림 trigger, 채널 철회, Vault-gated Cron, 활성 routine 기간 경계, occurrence별 취소 무효화, 본인 Push device listing, Push provider endpoint allowlist 및 subscription 입력 검증을 추가했습니다.
- 오류를 찾은 후 기존 migration을 덮어쓰지 않고 후속 migration으로 materializer alias, preference suppression, duplicate copy, occurrence-scoped invalidation을 보정했습니다.
- 최종 보안 점검에서 직접 RPC 호출로 Edge Function의 Push provider 호스트 검증을 우회할 수 있음을 확인했습니다. 후속 migration에서 RPC 자체에도 허용 provider 호스트, endpoint 형식, browser key 형식 및 만료 검증을 적용했습니다.
- in-app notification은 본인 recipient와 현재 Pet grant만 읽을 수 있습니다. `read_at`은 전용 RPC만 바꾸고, push endpoint/outbox/provider attempt는 클라이언트 권한에서 차단했습니다. 사용자 설정 변경은 본인 Pet grant 범위이며 읽기 전용 사용자의 개인 알림 선호 변경은 허용합니다.
- 수정 문서: `docs/ARCHITECTURE.md`, `docs/DATA-MODEL.md`, `docs/ACCESS-CONTROL.md`. 개인 건강 문맥이 포함된 로컬 문서는 수정하거나 업로드하지 않았습니다.

## 8. 로컬 검증 결과

- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `npm test` — 5 files, 22/22 PASS
- `npm run build` — PASS
- `PAGES_BASE_PATH=/hanilog/ npm run build` — PASS; PWA 하위 경로 참조 검사 PASS
- 로컬 `supabase migration up --local` — 신규 migration 적용 PASS. DB reset 없이 기존 합성 데이터 유지.
- `npx supabase test db` — 4 files, 77/77 pgTAP PASS. 알림 preference 기본값, 멱등 notification 생성, 권한 격리, HTTPS 및 provider endpoint 검사, schedule/미확인과 수행 사실 분리, 취소 무효화, retry attempt/audit, read/Health Event 분리를 포함.
- `npm run test:db:concurrency` — 독립 PostgreSQL session 2개를 실제 겹쳐 실행. 기존 동시 인슐린 event 2건 보존, 중복 가능성 경고, 멱등 재시도, 권한 철회 regression PASS.
- `npm run test:db:realtime` — grant 철회, generic invalidation, 서버 RLS 재조회, 다른 Pet 격리 regression PASS.
- `PAGES_BASE_PATH=hanilog npm run build` — PASS; GitHub Pages 하위 경로 PWA asset build 완료.
- 로컬 Supabase Edge Runtime mock integration — 인증된 Push subscription register/list/revoke, schedule outbox 생성, Push·Email mock acceptance, 동일 Worker 재호출 중 중복 전송 방지 및 테스트 fixture cleanup PASS. `RESEND_API_KEY`/VAPID key 없이 외부 요청은 전송하지 않았습니다.

## 9. GitHub Actions, 외부 및 기기 검증

- `.github/workflows/database-tests.yml`에 mock-only local Edge Functions 실행 단계를 추가했습니다. CI는 임시 worker token을 job 안에서 생성·마스킹하고, 로컬 Supabase DB·synthetic fixture만 사용합니다. 운영 Supabase, 서비스 secret, Pages deploy 단계가 없습니다.
- 신규 commit/push와 GitHub Actions 신규 run은 완료 보고 시점에 실제 상태로 기록합니다. 로컬 통과를 원격 CI PASS로 간주하지 않습니다.
- 실제 브라우저·모바일 기기 Push, Web Push endpoint 생존/브라우저별 지원, 사용자 잠금 화면, Resend 외부 이메일, 운영 Vault/Cron, 외부 provider rate-limit/webhook/bounce는 미검증.

## 10. 남은 보안·운영 위험

1. 운영 Supabase에서 migration 적용, Edge Functions 배포, Vault secret 등록 및 Cron 활성화는 별도 작업입니다. 이 단계에서는 진행하지 않았습니다.
2. Push는 provider 수락 후 Worker가 DB 성공 상태를 기록하기 전에 종료되면 retry에서 중복 알림이 가능할 수 있습니다. Provider acceptance는 실제 기기 수신·표시·열람을 의미하지 않습니다.
3. Web Push 암호 라이브러리와 브라우저 구현의 운영 적합성은 실제 브라우저 조합·독립 보안 검토 전 미확정입니다.
4. 개인정보 보존 기간, 전달/시도 데이터 보존·삭제·백업 정책, data region, 운영 복구 목표는 기존 `OPEN DECISION`으로 남습니다. 만료 표시는 자동 개인정보 삭제 정책을 대신하지 않습니다.
5. 이메일은 Auth 계정 이메일로만 보내며 verified address를 요구합니다. provider/domain이 없으면 실제 전달되지 않습니다.

## 11. 판정

**Phase 4: CONDITIONAL GO.** 로컬 DB/RLS, 동시성·Realtime 회귀, UI/build, push device control 및 Mock Push/Email Worker 검증은 통과했습니다. 신규 GitHub Actions 실제 run과 실기기·외부 provider 검증은 아직 남아 있으므로 Phase 5 착수는 공개 운영/실제 알림 전달이 아닌 개발 환경에 한정합니다. 원격 Actions 통과와 실제 브라우저 검증 후 운영 전달 설정을 별도 승인·검토해야 합니다.
