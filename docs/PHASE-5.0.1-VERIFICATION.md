# HaniLog — Phase 5.0.1 Notification Delivery Reliability Verification

**기준 커밋:** `ae29d2ca25659b5d6b8af4410c15ebc3af7e69b5`

**최종 판정:** **CONDITIONAL GO — 로컬 UI 검증은 준비 가능, 외부 알림 staging은 선행 조건 필요**

## 1. 결함의 원인

### Resend 429

기존 Worker는 `400–499` 응답을 영구 실패로 분류했습니다. 이 때문에 일시적인 rate limit인 `429`도 재시도되지 않았고, `Retry-After` 응답 헤더도 읽지 않았습니다.

### 여러 기기의 Push 부분 실패

기존 DB 상태는 사용자·채널별 Outbox 한 건만 기록했습니다. 사용자에게 여러 기기가 등록된 상태에서 앞선 기기 전송은 성공하고 뒤 기기 전송이 일시 실패하면, 성공 여부를 기기별로 저장하지 않아 다음 Outbox 재시도에서 앞선 기기에도 다시 보낼 수 있었습니다.

기존 Worker는 외부 공급자 호출과 상태 기록 사이의 불확실한 결과를 별도 표시하지 않았습니다. 이 동작은 재시도를 정확히 한 번 전달로 오해하게 만들 수 있었습니다.

## 2. 수정한 상태 및 재시도 모델

- Resend `429`, `408`, `5xx`는 재시도 대상으로 분류합니다. 일반적인 4xx는 영구 실패입니다.
- `Retry-After`의 초 단위 값과 HTTP 날짜를 파싱하고, 지수 백오프와 Jitter를 함께 적용합니다. 대기시간은 24시간 이내로 제한하고 기존 Outbox 만료 시각을 넘겨 보내지 않습니다.
- 동일 Resend Outbox에는 동일 `Idempotency-Key`를 유지합니다. Resend 문서는 키 보관 기간을 24시간으로 설명하므로, 그 기간이 지난 재시도에 대해 중복 방지를 보장하지 않습니다. [Resend Idempotency Keys](https://resend.com/changelog/idempotency-keys)
- `notification_push_deliveries`가 Outbox별 기기 구독 스냅샷과 기기별 상태·시도 횟수·lease·재시도 시각을 보존합니다. 구독 목록은 최초 한 번만 스냅샷하므로 나중에 등록된 기기에 오래된 알림을 소급 발송하지 않습니다.
- `notification_push_delivery_attempts`는 기기별 시도 이력을 추가로 보존합니다. 일반 사용자 접근은 차단하고 Worker/RPC 경로에서 추가하지만, `service_role`은 신뢰된 서버 권한이므로 DB superuser 수준의 변경까지 막는 불변 저장소는 아닙니다. `duplicate_possible`는 네트워크·서버 응답 등 공급자 수락 여부가 불명확한 재시도 가능성을 기록합니다.
- Push Worker는 성공한 기기를 다시 claim하지 않습니다. 종료 구독과 만료 구독은 재시도 대상에서 제외하고, Outbox 만료·취소·권한 철회·선호 해제 시 대기 중인 기기 작업을 차단합니다.
- Outbox와 기기별 Worker claim은 `FOR UPDATE SKIP LOCKED` 및 lease를 사용합니다. 기기별 최대 시도 횟수와 Outbox 최대 시도 횟수에 도달하면 영구 실패 상태로 종료합니다.
- `ACCEPTED`는 공급자의 요청 수락만 의미합니다. 실제 기기 도착·알림 열람·케어 수행을 나타내지 않습니다.

## 3. Migration 및 변경 파일

### DB 변경

`202610230010_phase501_delivery_reliability.sql`은 기존 테이블이나 기록을 삭제하지 않는 추가 migration입니다.

- `notification_outbox.push_targets_initialized_at`
- `notification_delivery_attempts.duplicate_possible`
- 서비스 전용 RLS 테이블 `notification_push_deliveries`
- 서비스 전용 append-only 테이블 `notification_push_delivery_attempts`
- Push 대상 스냅샷·claim·결과 기록 함수와 기존 Outbox 완료 함수의 호환 경로

### 코드 및 테스트

- `supabase/functions/notification-worker/index.ts` — Resend 분류, Retry-After, 기기별 Push 재시도, 권한 재확인 및 상태 저장 실패 응답
- `supabase/functions/_shared/notification-retry.ts` — Retry-After 파서 및 재시도 정책
- `src/lib/notification-retry.test.ts` — 파서·백오프·응답 분류 단위 테스트
- `supabase/tests/notifications.test.sql` — 기기 스냅샷, 부분 실패, retry 대상 격리, RLS 및 감사 이력 검증
- `scripts/test-notification-worker.mjs` — 두 Mock 기기, 429 Mock 응답, 동시 Worker 요청을 사용하는 통합 회귀

## 4. 검증 결과

### GitHub Actions

기준 커밋 `ae29d2c`에서 실제 실행한 결과:

- [Build validation — PASS](https://github.com/perfumerlee/hanilog/actions/runs/39976670117)
- [Local database verification — PASS](https://github.com/perfumerlee/hanilog/actions/runs/39976669909)
- Supabase CLI 고정 버전으로 새 로컬 테스트 DB 시작
- pgTAP 및 RLS: **87/87 PASS**
- PostgreSQL 독립 세션 동시성 회귀: PASS
- Realtime 권한 철회 회귀: PASS
- Mock Notification Worker 통합: PASS
- 두 Worker HTTP 요청이 같은 retry 창에서 겹쳐 실행된 증거: `overlap=true`, 두 요청의 총 claim 2건

Worker 통합 테스트에서 확인한 항목:

- 두 Push 기기 중 첫 기기는 수락 상태로 유지되고, 두 번째 기기만 재시도됨
- 재시도 완료 후 성공 기기의 provider 시도 횟수는 계속 1회
- Resend 429 Mock은 Outbox를 `PENDING`으로 유지하고 `Retry-After: 90`을 반영했으며 `duplicate_possible=false`로 저장
- 동일 요청 재호출 및 병렬 Worker 실행 후에도 완료 Outbox가 다시 전송되지 않음

### 로컬 명령

- `npm run typecheck` — PASS
- `npm run lint` — PASS
- `npm test` — **25/25 PASS** (순차 재실행 결과)
- `npm run build` — PASS
- `node --check scripts/test-notification-worker.mjs` — PASS

초기 병렬 검증에서 UI 테스트가 한 차례 타이밍 오류로 실패했으나, 단독 재실행에서 25/25 통과했습니다. GitHub Actions의 최종 Build validation도 통과했습니다.

## 5. 로컬 환경 및 미검증 범위

- 현재 Windows 세션에서 Docker Linux Engine named pipe를 찾지 못해 로컬 Supabase를 시작할 수 없었습니다. 로컬 `supabase test db` 및 로컬 Edge Function 통합은 실행하지 않았습니다.
- DB·동시성·Realtime·Worker 검증은 GitHub Actions의 새 Ubuntu runner에서 실행한 결과입니다. 이 테스트는 합성 계정·반려동물·기기 구독과 Mock provider만 사용했습니다.
- Resend에 실제 HTTP 요청을 보내지 않았습니다. 실제 429 응답 헤더·공급자 idempotency·전달 결과는 검증하지 않았습니다.
- 실제 Push provider, 브라우저·기기별 백그라운드 수신, 화면 잠금 상태, 사용자 실제 수신 및 열람은 검증하지 않았습니다.
- 이메일·Push를 실제 수신처로 발송하지 않았습니다.
- 로컬 UI 실사용 검증은 지금 환경에서 로컬 Supabase를 연결할 수 없어 **진행 불가**입니다. Docker Engine 복구 후 합성 계정으로 진행할 수 있습니다.

## 6. 중복 전달 및 운영 위험

- 이메일의 네트워크 단절 또는 `5xx`에서 공급자가 이미 요청을 수락했는지 알 수 없는 경우 동일 idempotency key로 제한적으로 재시도하고, 해당 Outbox 이력에 `duplicate_possible=true`를 남깁니다. Resend의 24시간 키 보관 기간 이후에는 재시도 중복을 배제할 수 없습니다.
- Push의 네트워크·서버 오류는 기기별 `duplicate_possible`에 기록한 뒤 재시도할 수 있습니다. Push provider는 앱의 DB 멱등성 키를 처리하지 않으므로 중복 가능성이 남습니다. 본 구현은 정확히 한 번 전달을 주장하지 않습니다.
- 권한·설정·알림 만료를 Worker가 발송 직전에 다시 확인하지만, 최종 확인 직후 외부 공급자 호출 전 권한이 철회되는 경쟁 구간은 외부 전달을 원자적으로 취소할 수 없습니다. 이미 공급자에게 제출된 메시지는 철회할 수 없습니다.
- 기기별 `subscription_key`는 endpoint hash이며 직접 endpoint를 복제하지 않습니다. 그래도 서비스 내부의 구독 식별 정보이므로 서버 전용 접근 정책과 향후 보존 정책 검토가 필요합니다.
- 외부 전송을 켜기 전에 Resend·VAPID 운영 키의 비밀 저장, 테스트 수신처, 전송 한도·비용, 보존 기간, 권한 철회 운영 절차를 확정해야 합니다.

## 7. 공개 저장소 및 Pages 확인

- 변경 파일만 추적 대상으로 검토했습니다. 비밀키 패턴과 개인 반려동물 건강 맥락은 발견하지 않았고, 유일한 이메일 패턴은 합성 테스트용 `example.test`였습니다.
- 미추적 상태였던 `docs/PHASE-5.0-READINESS.md`는 이번 공개 커밋에 포함하지 않았습니다.
- 현재 `.github/workflows/`에는 Build validation과 Local database verification만 있으며 Pages 배포 작업이나 `deploy-pages` 단계가 없습니다. 이번 커밋에서 실행된 Workflow도 이 두 검증뿐입니다.
- GitHub Pages 설정 API는 사용 가능한 GitHub connector의 허용 endpoint에서 조회되지 않아 저장소 설정 페이지의 현재 토글 자체는 독립 확인하지 못했습니다. 이번 작업에서 Pages 배포를 실행하지 않았습니다.

## 8. 로컬 UI 및 Phase 5.1 판정

로컬 UI는 Docker/Supabase가 복구되면 Mock Worker를 이용해 합성 데이터로 실사용 흐름을 점검할 수 있습니다. 실제 이메일이나 Push 검증과는 별도 단계로 유지해야 합니다.

**Phase 5.1 staging 준비: CONDITIONAL GO.** 데이터베이스와 Mock 전달 경로는 CI에서 통과했으나, 현재 개발 PC에서 Docker 기반 UI 통합이 막혀 있고 실제 provider 연동·비밀값·수신처·운영 개인정보 정책이 준비되지 않았습니다. 따라서 이 판정은 합성 데이터 전용 staging 구성과 모의 전달 검증을 시작할 수 있다는 뜻이며 실제 사용자 데이터나 외부 전달을 시작해도 된다는 뜻은 아닙니다.
