# Pet Health Log — Access Control

## 1. 보안 계약

- Household는 공동 관리 최상위 그룹이고 여러 Pet을 포함합니다.
- Household membership과 Pet 접근은 별도 관계입니다. membership만으로 건강 데이터 접근을 부여하지 않습니다.
- 의료진은 초대 및 승인된 Pet에 대해서만 접근합니다.
- 모든 요청에서 서버가 현재 권한을 확인하며, PostgreSQL RLS/grants를 독립적인 데이터 경계로 병행합니다.
- 브라우저 입력, 화면 숨김, 과거 JWT claim은 접근 증명이 아닙니다.
- 개인정보와 건강기록은 기본 비공개입니다. 사용자·Pet·가정 간 교차 접근은 기본 거부합니다.
- GitHub Pages는 공개 정적 클라이언트이며 데이터 권한 경계가 아닙니다. 브라우저에 전달되는 Supabase URL/publishable key는 공개값으로 취급하고, 데이터 보호는 RLS와 매 요청 서버 권한 검증으로 보장합니다.
- Supabase secret/service-role key 및 기타 서버 credentials는 browser bundle, Pages artifact, GitHub Actions output/log에 포함하지 않습니다. Edge Function secrets는 서버측 secret store에 둡니다.

## 2. 관계 모델과 역할

| 주체 | 관계 | 범위 |
|---|---|---|
| `PRIMARY_CAREGIVER` | `household_memberships` | Household 구성원/관리 기능 |
| `CAREGIVER` | `household_memberships` + `pet_access_grants` | grant된 Pet의 공동 돌봄 |
| `READ_ONLY` | membership가 있으면 + `pet_access_grants` | grant된 Pet의 조회만 |
| `CLINICIAN` | Household membership 없음; `care_team_links`/Pet grant | 초대 및 승인된 Pet의 명시 범위 |
| `SYSTEM_WORKER` | 서버 전용 인증/작업 권한 | 지정된 outbox 등 서비스 작업만 |

한 계정은 복수 Household membership을 가질 수 있습니다. Pet은 하나의 활성 Household에만 속합니다. MVP에서는 Pet 이전 UI를 제공하지 않습니다.
Household 생성자는 초기 `PRIMARY_CAREGIVER`가 되고, Household당 활성 primary는 정확히 한 명입니다. 마지막 primary는 successor를 지정하지 않고 탈퇴/철회할 수 없습니다. Pet 생성 시 해당 primary에게 Pet grant를 별도 생성합니다. Primary 이전은 새 primary 지정과 필요한 Pet grant 변경을 한 서버 트랜잭션으로 처리합니다.

## 3. CRUD 권한 행렬

기본 행위는 본인에게 접근 grant된 Pet 범위로만 유효합니다. 서버/RLS 검증 실패는 모든 UI affordance보다 우선합니다.

| 리소스/행위 | Primary caregiver | Caregiver | Read-only | Clinician (승인 Pet scope) |
|---|---:|---:|---:|---:|
| 자기 프로필 읽기/수정 | own only | own only | own only | own only |
| Household 읽기 | member | member | member | 금지 |
| Household 생성 | 허용 | 초대 수락 시 미생성 | 초대 수락 시 미생성 | 금지 |
| Household 멤버 목록 읽기 | 허용 | 허용(최소 정보) | 허용(최소 정보) | 금지 |
| Household 멤버 초대/역할 변경/철회 | CRUD 권한 | 금지 | 금지 | 금지 |
| Pet 등록/프로필 수정 | 허용 | 금지(기본) | 금지 | 금지 |
| Pet별 보호자 grant 부여/철회 | 허용, 감사 | 금지 | 금지 | 금지 |
| Pet profile 읽기 | grant된 Pet | grant된 Pet | grant된 Pet | 초대·승인 scope에서 허용 |
| Health Event 생성 | 허용 | 허용 | 금지 | MVP 금지 |
| Health Event 수정/삭제 | 직접 UPDATE/DELETE 금지. revision/void 생성 허용 | 동일 | 금지 | MVP 금지 |
| Routine 읽기 | grant된 Pet | grant된 Pet | grant된 Pet | 승인된 scope가 routine_read일 때 |
| Routine/version 생성·변경 | 허용 | 금지(기본) | 금지 | MVP 금지 |
| Care Plan/version 읽기 | grant된 Pet | grant된 Pet | grant된 Pet | 승인된 `plan_read` scope |
| Plan version 작성/승인 | 사용자 입력 초안 작성 가능; clinician 승인 표기 불가 | MVP 금지(기본) | 금지 | MVP 포털 미제공; 직접 승인 금지 |
| Safety Evaluation 조회 | grant된 Pet | grant된 Pet | grant된 Pet | 승인된 기록 scope 범위 |
| Safety Evaluation 직접 생성/수정 | 금지. 서버 명령만 | 금지 | 금지 | 금지 |
| Audit log 열람 | 기본 금지; 본인 활동 내보내기는 후속 | 기본 금지 | 금지 | 금지 |
| 데이터 내보내기 | 별도 기능/권한 결정 전 금지 | 금지 | 금지 | 금지 |
| 개인정보 삭제 요청 | 인증된 요청 생성/상태 조회 | 본인 요청 생성 | 본인 요청 생성 | 본인 계정 요청만 |
| Storage/첨부 파일 | MVP 미포함 | MVP 미포함 | MVP 미포함 | MVP 미포함 |

`OPEN DECISION`: Primary 이전의 UX(사전 successor 수락 후 이전 또는 확인된 atomic handoff). Household당 활성 primary 정확히 한 명, primary 없는 상태 금지, Pet grant의 트랜잭션 동시 변경은 확정 정책입니다. 제품 책임자가 Phase 2 멤버십 UI 전에 UX를 선택합니다.

## 4. 의료진 공유 범위

- 의료진에는 Household 권한을 부여하지 않습니다.
- 각 `care_team_link`는 Pet ID, scope, invited/accepted/approved/revoked/expired 상태, 승인 actor·시각, 만료(설정 시)를 가집니다.
- 권한은 열람 데이터 유형과 범위를 최소화합니다. 의료진 열람은 명시적으로 승인된 Pet만 허용합니다.
- 수의사 계정·자격 검증은 아직 확정하지 않았습니다. 인증 배지를 표시하거나 approval metadata를 자격 검증 사실로 해석하지 않습니다.
- MVP는 의료진 포털과 clinician event write/plan approval을 구현하지 않습니다.
- 열람 로그가 법률상/제품상 필요한 범위는 보존정책과 함께 결정합니다.

## 5. 초대·승인·철회

1. 초대자는 서버에서 현재 권한을 확인합니다.
2. 초대는 특정 Household membership과 필요한 Pet grants를 식별합니다. 초대 수락 전에는 데이터 접근이 없습니다.
3. 토큰은 단회성·만료형·저장 시 해시 처리로 설계합니다.
4. 초대 수락, Pet grant 부여, 역할 변경, 철회는 감사 행과 원자적으로 기록합니다.
5. 철회 시각 이후 새로운 DB/API/RLS/Realtime 요청은 현재 grant 부재로 거부합니다. access token의 과거 role claim을 무시합니다.
6. 이미 로컬 복사되거나 내보낸 데이터의 원격 회수는 보장하지 않습니다.
7. 오프라인 draft는 서버 권한을 우회하지 않습니다. 철회 후 제출은 거부하고 서버 확정 이벤트가 되지 않습니다. 이후 승인자가 처리하는 격리 workflow는 MVP 범위 밖입니다.

## 6. RLS 및 서버 검증

- 노출된 각 사용자 데이터 테이블에 RLS를 활성화하고 grants를 최소화합니다.
- 읽기·삽입·수정·삭제를 별도 정책으로 설계합니다. 민감 event의 직접 수정/삭제는 grants로 막고 전용 revision/void 명령만 허용합니다.
- 보호자 요청은 현재 활성 Household membership과 해당 Pet의 현재 `pet_access_grant`를 모두 만족해야 합니다.
- 의료진 요청은 현재 승인된 Pet별 `care_team_link` scope를 통과해야 합니다.
- 서버 명령은 Auth user를 입력 actor로 신뢰하되 pet/household 관계와 현재 권한을 쿼리에서 재검증합니다.
- 서비스 비밀 키를 브라우저에 노출하지 않습니다. 권한 우회 worker는 좁은 함수·작업에 한정하고 actor scope를 검증합니다.
- 보안 definer 함수는 기본 사용하지 않습니다. 필요 시 고정 `search_path`, 스키마 명시, 최소 execute grant, 명시 소유권 확인.
- Realtime은 `realtime.messages` RLS가 적용된 private Broadcast만 허용합니다. Pet topic은 현재 Household membership과 Pet grant를 확인하고, Household topic은 활성 membership, 사용자 topic은 `auth.uid()` 일치만 허용합니다. 클라이언트 메시지 발송 권한은 부여하지 않습니다.
- 실시간 payload는 `{kind: "invalidate"}` 또는 사용자 본인 topic의 `{kind: "access_changed"}`만 담습니다. 건강 이벤트 행, Pet/event ID, 기록값, 메모, 의료진 소견은 절대 payload에 포함하지 않습니다. 임상 테이블을 Postgres Changes publication에 두지 않습니다.
- grant/membership 변경은 독립된 본인 전용 `hanilog.user.<auth.uid>` 토픽으로 전달합니다. Pet topic만을 철회 알림 경로로 사용하지 않습니다. 클라이언트는 권한 변경 신호를 받으면 즉시 비공개 화면 상태를 비우고 기존 구독을 제거하며, 토큰 갱신 후 RLS/API로 Pet 접근을 재검증합니다.
- Supabase Realtime은 연결 중 RLS 권한 결정을 캐시할 수 있으므로 이미 열린 Pet 채널이 토큰 만료/갱신 전까지 남을 수 있습니다. 안전 경계는 payload 무정보성, 매 API/RPC의 현재 DB 권한검증, 별도 user-topic 철회 신호, 캐시 정리입니다. 오프라인 상태에서 철회를 즉시 전달하는 것은 보장하지 않으며, 재연결 시 서버 재검증 전에는 최신 기록으로 표시하지 않습니다.
- Storage는 MVP 미포함. 후속 추가 시 비공개 bucket과 Pet grant 기반 RLS를 적용합니다.
- Pages 정적 asset은 공개로 취급합니다. 인증 후 화면에서만 숨기는 것으로 보호되는 파일을 배포하지 않습니다. Supabase Auth redirect allowlist와 Edge Function CORS는 정확한 Pages origin/base에 제한하고, 미리보기 origin을 무분별하게 허용하지 않습니다.

## 7. 감사 추적 및 개인정보 최소화

감사 대상은 가입/가정 생성, 초대·수락·철회, Pet grant 변경, Care Plan/Version 작성·상태 전이, 임상 중요 Health Event 생성·정정·무효화, Safety Evaluation 생성, export/delete request, 관리자 접근입니다.

감사로그는 actor/action/target/UTC timestamp/request ID/result와 최소 이유를 보존하고 일반 사용자 UPDATE/DELETE를 막습니다. 감사 로그 보존 기간, 개인정보 보존기간, 데이터 처리 지역, 운영자 지원 접근은 미확정입니다. 미확정 상태에서 무기한 보존을 약속하거나 민감 본문을 log에 복제하지 않습니다.

계정·개인정보 삭제 요청은 건강 기록 정정/void와 별도 workflow입니다. 적용 법적 근거, 기록 비식별화, 감사 참조, 백업 만료 처리 결정 전 자동 cascade delete를 구현하지 않습니다.

`OPEN DECISION` 처리 표는 `IMPLEMENTATION-ROADMAP.md §5`를 따릅니다.
