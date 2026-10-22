# Phase 2 구현 보고서

## 1. 구현한 화면

- **Dashboard**: 선택된 Pet 프로필, 로컬 날짜 기준 오늘 기록, routine occurrence의 기록 확인/미확인, 최근 혈당·식사·인슐린 기록, 서버 마지막 확인 시각을 표시합니다. 기록이 없는 상태는 실제 미실시로 표현하지 않습니다.
- **Quick Record**: 혈당, 식사, 인슐린, 음수, 배변·배뇨, 운동, 체중, 증상·컨디션 입력을 지원합니다. 유형별 필수 필드를 검증하고, 실제 발생 시각을 기기 시간대에서 UTC ISO 시각으로 변환해 전송합니다.
- **Daily Timeline**: Pet 시간대 기준 날짜/시간순 기록과 서버 기록 시각, 기록자, occurrence, 수정·무효화 이력을 조회합니다. 상위 120개 서버 이벤트를 사용합니다.
- **Pet Switcher**: RLS가 허용한 Pet 목록만 표시합니다. 포커스 복귀 및 60초 간격으로 접근 목록을 새로 조회하고, 접근이 철회된 Pet 데이터를 화면에서 비웁니다.
- **모바일 UI**: 큰 입력 컨트롤, 키보드 focus 표시, 하단 네비게이션, 네트워크 상태 배너, 저장/조회 상태를 추가했습니다. 라우팅은 기존 HashRouter를 유지합니다.

## 2. 데이터 연동 방식

- 세션은 기존 Supabase Auth를 사용합니다. Pet, Household, event, routine, revision 및 plan 조회는 Supabase의 현재 사용자 RLS 세션으로 수행합니다.
- 새 기록은 기존 `record_health_event` RPC 하나로 제출합니다. RPC 호출에 Pet ID, event type, 발생 시각, 선택 occurrence, JSONB `value`, 단위, 클라이언트 멱등성 키, 시간대, 수행자 ID를 전달합니다. actor ID와 서버 입력 시각은 서버가 정합니다.
- 요청은 `retryOrCreateHealthEventCommand`로 같은 내용의 재시도에 같은 멱등 키를 사용합니다. RPC가 성공하고 event/evaluation 응답 필드가 확인된 뒤에만 “서버 기록 확인 완료”를 표시하고 최신 데이터를 다시 조회합니다. 불완전 응답이나 연결 오류는 확정으로 표시하지 않습니다.
- Supabase Realtime의 event 변경은 다시 조회하라는 힌트로 사용합니다. 표시 상태의 근거는 RLS 서버 조회 결과입니다.
- 브라우저 오프라인 시 제출을 막고 `UNVERIFIED` 상태를 표시합니다. 로컬 초안의 영속 저장이나 자동 제출은 구현하지 않았습니다.
- 앱 사용자 테이블은 타 사용자 프로필 조회가 자기 자신으로 제한되어 있어 공동 보호자는 이름 대신 UUID 일부를 표시합니다.

## 3. 기존 DB 계약과의 차이

DB migration/RPC/RLS는 변경하지 않았습니다. DB의 `event_type`에 이미 있는 8개 기록 유형을 사용하고, 세부 입력은 기존 JSONB `health_events.value` 및 `unit`에 저장합니다. exercise 활동 설명은 `value.activity_description`, 분은 `value.observed_value`로 저장합니다. meal 섭취 상태는 `value.meal_status`, 관찰량은 `value.observed_value`로 둡니다.

`record_health_event` RPC에는 전용 임상 투여량 필드가 없습니다. 따라서 UI에 용량 또는 투여 적정성 판단을 추가하지 않았습니다. Insulin 입력은 “이미 발생한 투여 사실” 확인을 요구하지만, 발생 사실을 안전 경고가 차단하지 않습니다. 서버 occurrence 사전 조회는 경고 UX를 위한 읽기이며, 최종 중복 가능성 평가와 기록은 RPC 트랜잭션의 책임입니다. 과거 시점 occurrence 조회는 routine occurrence 목록이 현재 `SCHEDULED` 상태로 제한되어 있어 연결 선택에 나타나지 않을 수 있습니다. 이때 occurrence를 선택하지 않은 사후 기록은 허용됩니다.

## 4. 통과한 검증

- `npm run typecheck` — 통과
- `npm run lint` — 통과
- `npm test` — 3개 파일, 15개 테스트 통과
- `npm run build` — 기본 경로 production build 통과
- `PAGES_BASE_PATH=/hanilog/ npm run build`에 해당하는 Windows 환경변수 빌드 — 통과. 생성된 JS/CSS, manifest, icon 경로가 `/hanilog/` 아래임을 확인했습니다.
- 기존 DB 테스트 재실행 — **미실행/실패**: 현재 세션에서 Docker CLI가 PATH에 없었고, Supabase 로컬 DB `127.0.0.1:54322` 연결이 거부되었습니다. CLI 출력은 `supabase start` 필요 상태를 반환했습니다. 기존 pgTAP 12/12 기록은 Phase 1.2 보고서의 과거 결과이며 이번 실행으로 재확인한 것으로 간주하지 않습니다.
- 이번 변경에서 repeatable PostgreSQL 동시성 회귀 테스트는 실행하지 않았습니다. Phase 1.2에서 발견된 수동 독립 세션 검증과 구분하여 미완료로 유지합니다.

## 5. 미완료 및 미검증 사항

- PostgreSQL pgTAP, 두 개 독립 세션 기반 반복 동시성/멱등성 회귀, 실 RLS 접근철회 검증은 현재 로컬 DB 미기동으로 재실행하지 못했습니다.
- 저장 실패·입력 검증·인슐린 중복 경고·사후 기록·선택되지 않은 occurrence의 UX는 Vitest 컴포넌트/단위 테스트로 확인했습니다. 실제 기기 네트워크 전환과 여러 브라우저 동시 사용은 미검증입니다.
- 실물 모바일 브라우저/스크린리더 검증은 하지 않았습니다. 공동 보호자 표시명 해석은 프로필 정책/RLS를 확장하기 전까지 UUID 일부로 제한됩니다.
- 타임라인은 최근 120개를 불러오며 페이지네이션은 없습니다. 별도 기록 상세 API 대신 각 항목의 펼침 영역을 제공합니다. 기록 정정 UI는 없고 서버에 이미 있는 revision 이력만 표시합니다.
- 오프라인 입력은 서버 확정 기록이 될 수 없으므로 제출을 비활성화합니다. 로컬 초안 저장/충돌 조정은 후속 작업입니다.
- 운동 시간은 기존 `value` 내 숫자 필드로 표현하고 별도 임상 단위 판단은 하지 않습니다. 기록 스키마 의미를 확장해야 한다면 후속 migration 전에 데이터 계약 검토가 필요합니다.

## 6. Safety Guard 연결 상태

- 인슐린 화면은 실제 발생 사실을 확인해야 저장 버튼을 누를 수 있고, 신규 투여를 유도하지 않습니다. 투여량, 임상 투여 승인, 혈당/식사 기준은 없습니다.
- 사용자가 occurrence를 선택하면 서버 event/revision을 먼저 조회해 기존 활성 기록 여부를 보여 줍니다. 조회 중/실패는 각각 확인 중/`UNVERIFIED`이며, 같은 occurrence 기록이 있으면 중복 가능성을 경고하지만 차단하지 않습니다.
- 계획 approval 상태를 의료진 확인/확인되지 않음/조회 불가로 표시합니다. 승인 확인은 투여 적정성 승인이 아님을 함께 알립니다.
- 최종 이벤트 삽입, idempotency, 동시성 경고, Safety Evaluation은 기존 PostgreSQL RPC가 권위자입니다. RPC 실패/권한 거부/불완전 응답에서는 확정 상태를 표시하지 않습니다.
- Realtime/사전 조회는 편의 정보이며 최신성 또는 치료 판단을 보장하지 않습니다.

## 7. Phase 3 착수 판정

**CONDITIONAL GO**. UI·타입·린트·단위 테스트 및 기본/서브경로 빌드는 통과했고 DB 계약은 변경하지 않았습니다. Phase 3에서 운영 또는 임상적으로 중요한 사용 흐름을 확장하기 전에 로컬 Supabase를 기동해 pgTAP을 다시 통과시키고, 두 독립 세션을 이용한 반복 동시성 회귀와 권한 철회 직후 제출 거부를 검증해야 합니다. 해당 결과가 확보되기 전에는 이번 UI를 서버 안전 계약이 완전히 재검증된 것으로 보아서는 안 됩니다.
