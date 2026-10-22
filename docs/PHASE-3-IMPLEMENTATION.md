# HaniLog — Phase 3 구현 보고서

**상태:** 구현 준비 코드 작성 완료, DB 통합 검증 차단  
**테스트 데이터:** 코드와 pgTAP에 합성 fixture만 정의. 로컬/운영 DB에 적용되지 않음  
**운영 배포:** 미실행

## 1. 구현 기능 및 화면

### 공동 보호자

- `/shared` 화면에서 Household, 역할, Pet별 grant, 초대 상태를 관리합니다.
- Primary caregiver만 초대를 만들고, Pet 목록과 `CAREGIVER`/`READ_ONLY` 역할을 지정할 수 있습니다.
- 초대 토큰은 32바이트 난수로 생성해 한 번 반환합니다. DB에는 SHA-256 digest만 저장합니다. 로그인 이메일 일치, 만료, 사용 여부를 서버 RPC가 검증하며 수락 전에는 권한을 만들지 않습니다.
- 수락·거절·만료·철회와 Household 멤버십/Pet grant 변경은 감사로그 대상입니다. Household 멤버 철회는 멤버십과 그 가정의 모든 Pet grant를 같은 트랜잭션에서 철회합니다.
- 초대 링크는 이메일로 자동 발송하지 않고 화면에서 복사해 전달하는 방식입니다. 비로그인 상태에서 연 초대는 로그인 후 초대 경로로 돌아오도록 처리했습니다. 이메일 확인이 필요한 신규 계정은 확인 후 원래 초대 링크를 다시 열어야 할 수 있습니다.

### Care Routine 및 Safety Guard

- `/care`에서 요일, 하루 여러 현지 시각, 단계 순서와 사용자가 정의한 안내용 선행 단계를 구성합니다. 빈 입력 상태로 시작하며 치료 시간·용량·섭취량·운동 강도 기본값은 없습니다.
- 수정 시 새 Routine Version을 생성합니다. 이미 만든 occurrence와 연결 Health Event는 보존하고, 기존 미래 예정 occurrence는 `SUPERSEDED` 처리합니다.
- Pet 시간대 기준으로 해당 날짜의 occurrence를 서버가 생성합니다. DST 모호/존재하지 않는 시각은 자동으로 보정하지 않고 `SCHEDULE_TIME_UNRESOLVED`로 표시합니다.
- 발생 기록은 기존 Health Event RPC로 저장하며 occurrence 연결을 지원합니다. 실제 발생 시각과 서버 기록 시각, 기록자를 구분합니다.
- `evaluate_routine_occurrence` RPC가 서버의 최신 기록과 정정 이력을 읽어 평가 스냅샷을 생성하거나 동일 근거의 기존 스냅샷을 재사용합니다. 개인이 입력한 순서는 임상 선행 조건으로 추론하지 않고 `ROUTINE_ORDER_UNCONFIRMED`로 구분합니다. 동일 슬롯의 인슐린 중복 가능성, 식사 기록 미확인, 사용자 보고 식사 예외 및 미승인 계획 상태를 표시합니다.
- `CURRENT`는 평가 시 서버 데이터가 확인됐다는 뜻입니다. 투여 안전성이나 의료적 허가를 의미하지 않습니다. 경고 확인은 별도 append-only `safety_acknowledgements` 행으로 남깁니다.
- 실제 발생한 행위의 사후 기록은 경고와 분리되어 기존 RPC를 통해 허용됩니다.

### 실시간 상태 공유

- Dashboard와 Care Routine은 인증 Supabase 세션으로 Pet 필터의 `health_events`, `routine_occurrences`, `safety_evaluations` 변경을 구독합니다.
- 이벤트는 화면 재조회 신호로만 쓰며, Supabase 쿼리/RPC 응답이 최종 표시 근거입니다. 초기 연결·재연결 후 서버에서 다시 조회하고 연결 장애를 표시합니다.
- Postgres Changes의 테이블 RLS를 데이터 접근 경계로 사용합니다. 채널 이름 자체는 보안 경계가 아닙니다.
- Pet 접근이 사라지면 목록 재조회 후 해당 Pet의 이벤트·revision·occurrence·계획 상태를 비웁니다. 앱의 기존 포커스 및 주기적 권한 재확인도 유지합니다.

이메일·Web Push Notifications Worker, clinician portal, 임상 승인 UI, 로컬 초안 동기화는 이번 구현에 포함하지 않았습니다.

## 2. 생성·수정 파일

### 신규

- `src/ui/SharedCarePage.tsx`
- `src/ui/CareRoutinePage.tsx`
- `src/ui/CareRoutinePage.test.tsx`
- `supabase/migrations/202610210002_phase3_shared_care_routines.sql`
- `supabase/tests/phase3_shared_care.test.sql`
- `docs/PHASE-3-IMPLEMENTATION.md`

### 수정

- `src/ui/App.tsx` — 라우트·하단 탐색·초대 후 로그인 복귀·Realtime 상태 및 재조회·occurrence 연결
- `src/ui/styles.css` — 모바일 5개 메뉴, 공유 돌봄·루틴 화면 스타일
- `src/lib/event-command.ts` — 비임상 `ROUTINE_ORDER_UNCONFIRMED` 사용자 문구
- `src/lib/event-command.test.ts` — 비임상 경고 문구 테스트

`package.json`, 기존 Phase 1 migration, 운영 환경, Pages 배포 설정은 변경하지 않았습니다.

## 3. DB migration 및 접근권한 변경

새 migration은 다음을 정의합니다.

- `household_invitations`: 초대 대상 이메일, 허용 역할/Pet 범위, 해시 토큰, 상태, 만료와 해결 행위자/시각
- `safety_acknowledgements`: 경고 평가, 확인 코드, 행위자, 확인 시각의 append-only 이력
- `care_routines.name` 추가
- 초대 생성/수락/거절/철회, Pet grant 변경, Household 멤버 철회 RPC
- 사용자 루틴의 Plan/Version 생성·새 버전 저장 및 반복 occurrence 생성 RPC
- 서버 Safety Evaluation 및 경고 확인 RPC
- Health Event 추가 후 같은 반복 슬롯의 기존 CURRENT 평가를 STALE로 바꾸는 trigger
- `supabase_realtime` publication이 있으면 필요한 세 테이블을 멱등하게 추가

공개 테이블 직접 쓰기는 계속 금지하고, RPC가 현재 Household membership과 Pet grant를 검사합니다. 초대 토큰은 어떤 조회 정책으로도 반환되지 않습니다. Medical plan 승인 상태는 사용자가 입력한 Routine 순서를 임상 검증된 조건으로 승격시키지 않습니다.

**중요:** 이 migration은 현재 실행 환경에 적용되지 않았습니다. Docker CLI 부재로 로컬 PostgreSQL 접근이 불가능했습니다. SQL migration과 새 pgTAP 테스트는 검토용 작성물이며 실제 DB 동작이 확인된 구현이라고 간주하지 않습니다.

## 4. Safety Guard 동작 결과

코드에 정의한 서버 상태 흐름:

1. 권한이 확인된 보호자가 Routine 화면을 열거나 서버에서 새로고침합니다.
2. 서버가 날짜·반복 규칙으로 occurrence를 준비하고 DB의 유효 Health Event 및 revision을 읽습니다.
3. 서버 Safety Evaluation을 저장/재사용하고, 화면은 상태 코드와 결과 코드를 그대로 분리 표시합니다.
4. 보호자는 경고를 확인할 수 있지만 확인은 위험 해소나 의학적 승인으로 기록되지 않습니다.
5. 실제 발생 행위는 기존 멱등성 RPC로 사후 기록합니다. 응답이 실패/불완전하거나 권한이 불명확하면 확정으로 표시하지 않습니다.

서버 판정은 임상 투여량·투여 가능 여부·혈당·섭취량 임계값을 계산하지 않습니다. 식사 거부/일부 섭취는 사용자 관찰값일 뿐 자동 의학 조치로 연결하지 않습니다. 이 동작은 아직 DB에서 실행·검증되지 않았습니다.

## 5. 공동 보호자 동시성 및 Realtime 검증

- 동시성 회귀 명령 `npm run test:db:concurrency`를 시도했으나, PowerShell이 `docker` 명령을 찾지 못해 PostgreSQL 세션을 열지 못했습니다.
- 두 보호자가 동시에 초대를 수락하거나 grant를 갱신하는 DB 실행 테스트는 수행되지 않았습니다.
- Realtime 채널 연결·재연결·두 브라우저 반영·권한 철회 시 구독 차단을 실제 Supabase에서 검증하지 않았습니다.
- SQL 테스트 파일에는 초대 만료/재사용/이메일 불일치, Pet grant 및 철회, 루틴 새 버전과 과거 occurrence 보존, 서버 경고 평가/확인 이력 및 사후 event 시간 보존 시나리오를 작성했습니다. 전체 DB 테스트 계획은 **22 assertion**이며 실행 전 상태입니다.
- 기존 Phase 2.1 보고서의 과거 동시성 결과는 이번 Phase 3 코드 검증으로 간주하지 않았습니다.

## 6. 통과한 프런트엔드 검증

- `npm run typecheck` — 통과
- `npm run lint` — 통과
- `npm test` — **4개 파일, 19/19 통과**. 신규 Routine UI의 오프라인 `UNVERIFIED` 표시와 권한 확인 전 편집 비활성, 비임상 순서 경고 문구 테스트 포함
- `npm run build` — 통과, PWA 산출물 생성
- GitHub Pages 실제 배포는 하지 않았습니다.

## 7. 미완료 및 미검증 항목

- 새 migration의 PostgreSQL 문법·제약·RLS·RPC 실행 및 pgTAP 전체 결과
- `npm run test:db:concurrency`에서 서로 독립된 실제 PostgreSQL 세션의 동시 투여 기록·lock 경합·멱등성·권한 철회 결과
- 실제 Supabase Realtime 연결 해제/재연결과 다중 브라우저 공동 보호자 반영
- 운영 환경과 분리된 브라우저 통합 검증, 모바일 실기기·스크린리더 접근성
- DST 전환일 occurrence 생성, Routine 대량/장기 사용 부하, 오래된 초대 정리 정책
- 초대 이메일 전달, 이메일/Web Push worker와 전달 실패/중복 정책
- 비로그인 초대→신규 회원 가입→이메일 확인 후 초대 복귀의 공급자별 Auth redirect 동작
- 의료진 자격 확인, 승인 계획 생성·승인 권한 및 임상 경고 기준
- 데이터 보존·삭제 정책, 백업/복구 목표 및 개인정보 처리 지역

Routine 날짜 occurrence는 해당 날짜에 사용자가 화면을 열 때 생성됩니다. 매일 앱을 열지 않아도 일정을 미리 생성·알림해야 하는 요구가 확정되면 별도 스케줄러/worker가 필요합니다.

## 8. Phase 4 착수 판정

**NO-GO — DB 통합 검증 전에는 Phase 4에 착수하지 않습니다.**

Typecheck, lint, Vitest 및 build는 통과했습니다. 그러나 초대·권한철회·Routine·Safety Evaluation을 구현하는 새 migration과 pgTAP 테스트가 실행되지 않았고, 요청된 동시성·RLS·Realtime 검증도 수행되지 않았습니다. `npx supabase status`, `npm run test:db`, `npm run test:db:concurrency` 모두 이 실행 세션에 Docker CLI가 없어 중단됐습니다. Docker Desktop의 CLI 경로/PATH를 복구하고 로컬 Supabase를 확인한 다음 migration 적용, `npx supabase test db`, 실제 동시 세션 회귀 및 RLS/Realtime 통합 검증을 통과해야 다음 단계로 진행할 수 있습니다.
