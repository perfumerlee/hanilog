# Phase 2.1 통합 검증 보고서

검증 일자: 2026-10-21 (Asia/Seoul)  
환경: Windows, Docker Desktop Linux Engine, 로컬 Supabase `hanilog`, PostgreSQL 15  
데이터: 이번 통합 검증에서 만든 합성 계정·Household·Pet·Plan·Occurrence·Health Event만 사용. 원격 Supabase, 운영 데이터, 공개 배포는 사용하지 않음.

## 1. DB 연결 실패 원인

Phase 2 보고서의 `127.0.0.1:54322 ECONNREFUSED`는 실제 DB 장애로 확인되지 않았다. 이 실행 컨텍스트에서는 Docker가 PATH에 없고, Docker Linux Engine named pipe와 localhost 포트가 샌드박스에서 접근 거부됐다. Supabase CLI도 기본 `C:\Users\leeta\.supabase` 디렉터리를 만들려다 권한 오류를 냈다. 이전 검증에서 사용한 별도 `SUPABASE_HOME` 경로와 Docker 실행 파일 경로를 지정하고 승인된 로컬 환경에서 확인하자 Docker Engine과 DB는 이미 실행 중이었다.

따라서 장애 원인은 코드나 migration이 아니라 **샌드박스/CLI 실행 환경의 접근 경로 차이**로 판단한다. `npx supabase start`로 DB를 재생성하거나 `db reset`을 실행하지 않았다.

## 2. 복구 조치 및 서비스 상태

- Docker CLI: `29.9.1`; Docker Server: Linux Engine `29.9.1`, 응답 정상.
- Supabase CLI: 프로젝트 의존성 `2.121.0` 사용.
- DB 포트 `127.0.0.1:54322`: 연결 가능. PostgreSQL `15.19`.
- API `54321`, Studio `54323`, Mailpit `54324` 포함 핵심 서비스가 healthy 또는 실행 상태였다.
- Vector와 analytics/Logflare 경로, imgproxy, pooler는 중지 상태였다. Vector의 비인증 TCP `2375`는 활성화하지 않았고, 저장소 설정도 변경하지 않았다.
- UI 장애 UX 검증에서 Kong API 컨테이너를 잠시 중단했다가 다시 시작했다. 마지막 확인 시 Kong은 healthy였고 Auth, REST, Realtime, Storage, DB도 정상 상태였다.
- 로컬 migration 목록은 `202610210001` 하나이며 로컬 적용 상태와 일치했다. Supabase 상태의 `linked_project`는 null이어서 원격 프로젝트 연결은 없었다.

## 3. pgTAP 및 자동 동시성 회귀

### pgTAP

`npx supabase test db` 최종 실행 결과: **12/12 PASS**. 테스트는 `supabase/tests/database.test.sql` 한 파일에서 실행됐다. RLS 기반 타 Household 접근 거부, 가정·Pet 권한, 미확인 식사와 미승인 계획 상태, 중복 가능성 및 멱등 재시도를 포함한 기존 계약을 확인했다.

### 반복 가능한 동시성 테스트

`npm run test:db:concurrency`와 [test-concurrency.ps1](../scripts/test-concurrency.ps1)를 추가했다. 실행마다 고유한 합성 사용자와 Pet/Occurrence를 만들고, 두 개의 독립 `psql` 프로세스/DB backend로 RPC를 경쟁시킨다. A가 occurrence advisory transaction lock을 가진 동안 B의 backend가 `pg_stat_activity`에서 같은 advisory lock을 기다리는 것을 확인한 뒤 A를 진행시킨다. 테스트 종료 시 그 실행이 만든 fixture ID만 정리한다.

마지막 실행 증거:

| 세션 | PostgreSQL PID | RPC/잠금 시작 시각 (UTC) | 응답 |
|---|---:|---|---|
| 보호자 A | 3742 | lock 보유 11:01:11.292190, RPC 응답 11:01:18.337295 | 이벤트 1개, `PLAN_UNVERIFIED` |
| 보호자 B | 3755 | RPC 시작 11:01:11.935867, 응답 11:01:18.347688 | 별도 backend에서 잠금 대기 후 이벤트 1개, `DUPLICATE_POSSIBLE`, `PLAN_UNVERIFIED` |

검증 결과:

- 두 PID가 달랐고, B가 잠금을 기다리는 상태를 테스트에서 관측했다. 실행은 순차 시뮬레이션이 아니다.
- 두 요청의 `occurred_at`, Health Event, 감사행, Safety Evaluation이 각각 보존됐다.
- 같은 actor·본문·멱등성 키 재전송은 기존 event ID를 반환했고 세 번째 이벤트를 만들지 않았다.
- Pet Grant를 철회한 뒤 B의 이벤트 쓰기는 `FORBIDDEN`으로 거부됐고, RLS 조회에서 Pet 및 이벤트가 모두 0건이었다.
- 실행 종료 후 테스트가 생성한 고유 fixture만 정리했다.

확인하지 않은 DB 항목: 별도 비정상 잠금으로 만든 deadlock/`40P01` 재시도 정책과 장기 부하는 이번 반복 테스트 범위가 아니다. lock timeout과 롤백은 Phase 1.2 보고서에 기록된 별도 수동 확인 결과를 참조한다.

## 4. Phase 2 UI·RPC 통합 확인

로컬 Vite 개발 서버와 로컬 Supabase를 연결하고, 브라우저에서 무작위 합성 계정으로 수행했다.

- 계정 생성 후 Auth 세션이 표시됐고, RLS로 허용된 Pet 목록을 조회했다. Dashboard에서 합성 Household와 Pet을 만들었다.
- 식사, 혈당 및 인슐린 기록을 기존 `record_health_event` RPC로 제출했다. 응답의 event/evaluation 필드가 유효할 때만 서버 확인 완료로 표시됐다.
- 실제 발생 시각과 서버 기록 시각을 타임라인에서 분리해 확인했다. 타임라인에는 서버 재조회로 확인된 식사 2건, 혈당 1건, 인슐린 2건이 표시됐다. DB 집계는 총 5 Health Event, 5 멱등 레코드였다.
- 합성 insulin occurrence와 미승인 계획을 준비했다. UI는 기존 기록 없음/계획 승인 미확인을 표시했고, 첫 사후 기록 후 재조회에서 기존 기록을 표시했다. 두 번째 실제 발생 보고는 차단하지 않았으며, RPC 결과에 따른 `DUPLICATE_POSSIBLE` 경고와 `PLAN_UNVERIFIED`를 표시했다. 두 이벤트와 두 Safety Evaluation은 DB에서 확인됐다.
- 잘못된 요청 성공 표시는 없었다. Kong이 잠시 중지된 동안 식사 제출 UI는 `UNVERIFIED`를 표시하고 입력을 유지했다. Kong 복구 후 같은 입력을 재시도해 한 건만 저장됐고 성공 확인 뒤 입력을 비웠다. DB에는 해당 재시도 기록 1건만 추가됐다.
- 타 Household 접근 차단과 권한 철회 후 읽기·쓰기는 pgTAP/실제 DB 회귀에서 검증했다. 브라우저에서 별도 Household 전환을 직접 시도하지는 않았다.
- 계획 상태는 의료진 확인 여부로만 표시했고, 의료적 투여 승인은 없다는 문구를 확인했다. 인슐린 용량·혈당 기준·투여 적정성 판단은 입력하거나 계산하지 않았다.

이번 브라우저 테스트가 만든 합성 로그인 사용자, Household, Pet, 개인 루틴 Plan/Occurrence 및 5개 Health Event는 **로컬 DB에 남겨 두었다**. 기존 데이터나 해당 UI 테스트 데이터를 삭제하지 않았다. 자동 동시성 스크립트는 별도 실행용 fixture만 자체 정리한다.

## 5. 회귀 검증

- `npm run typecheck` — 통과
- `npm run lint` — 통과
- `npm test` — 3개 파일, **16/16 PASS**. 오프라인 입력이 서버 확정으로 표시되지 않고 저장이 비활성화되는 화면 검증을 추가했다.
- `npm run build` — 통과
- `PAGES_BASE_PATH=/hanilog/ npm run build` — 통과. JS/CSS, PWA 등록 스크립트, 아이콘과 manifest 경로가 하위 경로를 사용하고 manifest `start_url`/`scope`가 `/hanilog/`임을 확인했다.
- `dist` 산출물에서 `sb_secret_`, `SERVICE_ROLE_KEY`, `service_role` 표식 0건. 배포 번들에 service key를 포함하지 않았다.
- 실제 GitHub Pages 배포는 하지 않았다.

## 6. 발견 및 수정

- DB 연결 거부는 로컬 DB 재기동 없이 샌드박스 밖에서 연결 경로와 `SUPABASE_HOME`을 보정해 해결했다. 운영 설정, Docker TCP 2375, migration은 바꾸지 않았다.
- 두 세션의 backend PID와 실제 advisory lock 대기를 확인하는 반복 가능한 자동 회귀 스크립트를 추가하고, npm 실행 명령을 연결했다.
- 자동 테스트 작성 중 PowerShell 5.1의 `ProcessStartInfo.ArgumentList` 미지원과 psql 출력 assertion 정규식 문제를 발견해 호환 방식으로 수정했다. 최종 자동 테스트에서 동시성, 멱등성, RLS 읽기·쓰기 철회가 모두 통과했다.
- DB migration 및 RPC 계약은 수정하지 않았다.

## 7. 미검증 항목

- 브라우저의 실제 OS 네트워크 오프라인 전환은 수행하지 않았다. 오프라인 입력 비확정/저장 비활성은 Vitest로 확인했고, 서버 게이트웨이 중단 UX는 실제 브라우저에서 확인했다. IndexedDB 초안은 현재 구현되어 있지 않다.
- 여러 브라우저/실기기에서의 공동 보호자 세션, 토큰 갱신 지연, 모바일 기기·스크린리더의 실기기 검증은 미실행이다. 브라우저 UI 검증은 데스크톱 브라우저에서 진행했다.
- 서로 다른 Household의 Pet을 직접 ID 조작해 UI에서 요청하는 별도 브라우저 테스트는 하지 않았다. 서버 RLS 차단은 DB 테스트에서 확인했다.
- 사용자가 네트워크 실패 후 입력값을 변경해 제출하는 조합, DB commit 후 응답만 유실되는 proxy 실패의 UI 자동 시나리오는 미검증이다. DB RPC의 동시성 및 멱등 재시도는 자동 회귀가 통과했다.
- 동시성 스크립트는 Windows PowerShell 및 Docker Desktop 로컬 이름 `supabase_db_hanilog`를 기본으로 한다. Linux/self-hosted CI에서는 runner를 별도 이식해야 한다.

## 8. Phase 2 종료 및 Phase 3 착수 판정

**CONDITIONAL GO**

Phase 2 UI가 로컬 Auth/DB/RPC와 실제로 연결되어 기록 저장, 타임라인 재조회, 중복 경고, 서버 오류 후 미확정 표시, 권한 철회 차단까지 통합 확인됐다. pgTAP과 독립 DB 세션 자동 동시성 회귀도 통과했다. 데이터 계약이나 임상 규칙은 추가·변경하지 않았다.

Phase 3 개발 착수는 가능하다. 다만 실제 오프라인 네트워크/모바일 기기 검증을 출시 전 조건으로 유지하고, IndexedDB 초안을 추가한다면 서버 확정 기록과 명확히 분리해야 한다. 운영 또는 임상 사용 전에는 백업·복구와 개인정보 보존 정책, 수의사가 정의할 임상 기준을 별도로 해결해야 한다.
