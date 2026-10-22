# Phase 1.2 안정화 및 동시성 검증

검증 일자: 2026-10-21  
환경: Windows, Docker Desktop Linux Engine, Supabase CLI 2.121.0, 로컬 프로젝트 `hanilog`  
데이터: 이 보고서의 테스트에서 새로 만든 합성 사용자·반려동물·루틴 및 이벤트만 사용

## 1. Vector 장애 원인 및 조치

### 판정

Vector 재시작의 직접 원인은 Docker Engine 장애가 아니라 Vector의 Docker 로그 수집 연결 실패였다. 컨테이너 환경은 `DOCKER_HOST=http://host.docker.internal:2375`를 사용했고, 로그에 `192.168.65.254:2375` 연결 거부가 반복됐다. 관측 당시 Vector 재시작 횟수는 64회였다. Windows Docker Desktop은 Docker Engine에 네임드 파이프 경로를 사용하며, 해당 TCP 포트는 이 환경에서 열려 있지 않았다.

비인증 TCP 2375는 활성화하지 않았다. Vector와 Logflare는 로컬 개발 스택의 로그 수집·분석 경로이며 HaniLog의 PostgreSQL, Auth, REST, RLS 및 pgTAP 실행에 필수 조건이 아니다.

### 조치와 확인

- `supabase stop`의 기본 백업 동작으로 로컬 스택을 중지했다. 볼륨 삭제 옵션은 사용하지 않았다.
- `npx supabase start -x vector,logflare`로 Vector와 Logflare만 제외해 재기동했다. 설정 파일은 변경하지 않았다.
- 재기동 후 Vector/Logflare 컨테이너는 없었고, PostgreSQL·Auth·REST·Realtime·Storage·Studio·Kong·Edge Runtime·Inbucket·pg_meta는 실행 중이었다. PostgreSQL, Auth, Realtime, Storage, Studio, Kong, Inbucket, pg_meta는 healthy였다. DB 재시작 횟수는 0이었다.
- 제외 구성에서 `npx supabase test db`를 다시 실행해 pgTAP **12/12 PASS**를 확인했다.

따라서 로컬 기능 개발 중 로그 수집이 필요하지 않다면 `-x vector,logflare` 사용은 안전한 우회 방법으로 검증됐다. 통합 로그 기능을 확인해야 하는 작업에서는 별도 해결이 필요하다. 비인증 Docker TCP 포트를 여는 방식은 사용하지 않는다.

## 2. Supabase 핵심 서비스 및 저장 위치

로컬 DB 컨테이너 `supabase_db_hanilog`는 healthy 상태였다. 이 환경은 원격 Supabase 프로젝트와 연결하지 않았다. Phase 1 migration `202610210001_phase1_foundation.sql`은 로컬 DB에 적용되어 있었고, 테스트 재실행 후에도 정상 통과했다.

Docker Engine은 Linux 컨테이너 모드였고 `DockerRootDir`는 컨테이너 내부 `/var/lib/docker`다. DB Docker 볼륨은 그 경로에 마운트되며, 이를 담는 WSL 가상 디스크는 `E:\Docker\WSL\disk\docker_data.vhdx`에서 확인했다(10,515,120,128바이트). `E:\Docker\WSL\main\ext4.vhdx`는 100,663,296바이트였다.

검증 시점 여유 공간:

| 드라이브 | 여유 공간 | 관찰 |
|---|---:|---|
| C: | 1.29 GiB | 빌드·이미지 다운로드를 반복하기에는 부족한 편 |
| E: | 653.42 GiB | Docker WSL 데이터 파일이 위치함 |

검증 중 Docker 이미지·볼륨·프로젝트 파일을 정리하거나 삭제하지 않았다. 현재 테스트는 공간 부족 없이 끝났다. C:의 여유가 적으므로 불필요한 빌드 산출물과 캐시를 정리하려면 먼저 목록과 예상 확보량을 확인하고 별도 승인 후 수행하는 편이 안전하다. Docker prune이나 볼륨 삭제는 수행하지 않았다.

## 3. 동시성 테스트 환경과 실행 증거

### 방법

서로 다른 Docker `exec` 프로세스에서 각각 `psql` 연결을 열어 PostgreSQL 세션 두 개를 사용했다. 요청은 인증된 사용자 A와 B의 JWT claim을 설정하고 실제 `public.record_health_event(...)`를 호출했다. 두 세션은 새 합성 Routine Occurrence와 동일한 Pet을 사용했다.

첫 번째 요청의 트랜잭션이 함수 내부와 같은 occurrence advisory transaction lock을 취득한 채 대기하도록 해 잠금 경합 구간을 만들었다. 그 잠금이 유지되는 동안 두 번째 세션이 RPC를 시작했다. 도구의 호출 지연 때문에 `pg_stat_activity` 표본 쿼리는 일부 실행에서 세션 종료 뒤 도착해 행을 반환하지 않았다. 이 표본은 동시성 증거로 사용하지 않았다. 아래의 두 PostgreSQL backend PID, 시작·완료 시각 및 클라이언트 결과를 근거로 삼았다.

### 겹친 실행의 기록

Occurrence `20000000-0000-4000-8000-000000000013`에 대해:

| 세션 | PostgreSQL PID | 로그 시각(UTC) | 결과 |
|---|---:|---|---|
| A | 1019 | 잠금 보유 10:10:11.215320, 기록 RPC 시작 10:10:56.242923 | 이벤트 `8e0bbbc8-5170-4f9e-b0a0-a71d8df6457e`, `PLAN_UNVERIFIED` |
| B | 1041 | RPC 시작 10:10:29.629083, 함수 응답은 A 커밋 뒤 10:10:56.287406에 기록됨 | 이벤트 `ab9b1380-dcd4-4c99-a91b-78ad1bd4f5f7`, `DUPLICATE_POSSIBLE`, `PLAN_UNVERIFIED` |

B는 A가 잠금을 보유한 구간에 별도 backend에서 RPC를 시작했고, 응답은 A의 잠금 해제·커밋 뒤 도착했다. 따라서 요청은 순차 실행이 아니라 실제로 겹쳤다. 이 검증은 동일 occurrence 잠금에서 B가 대기한 뒤 최신 이벤트를 보고 경고하는 흐름을 확인한다.

두 이벤트 모두 보존됐다. `occurred_at`은 각각 `2026-10-21T00:01:17Z`, `2026-10-21T00:02:09Z`로 유지됐고, 서버 기록 시각은 각각 `2026-10-21T10:10:56.271606Z`, `2026-10-21T10:10:56.279259Z`였다. Safety Evaluation은 동일 occurrence와 plan version을 참조한다. 첫 평가는 이벤트 A만, B의 평가는 A와 B 모두를 `evidence_event_ids`에 포함했다. 두 Health Event 각각에 대해 감사 로그가 하나씩 존재했고, 각 요청의 idempotency key가 `request_id`에 기록됐다.

## 4. 멱등성·경고·실패 처리

### 확인 결과

- 같은 actor·operation·idempotency key와 같은 요청 본문을 재전송했을 때 원래 `event_id`와 `evaluation_id`가 반환됐다. 이벤트 수는 증가하지 않았다.
- 같은 키를 다른 Pet 및 다른 요청 본문으로 재사용했을 때 SQLSTATE `23505`, `IDEMPOTENCY_KEY_REUSED`가 반환됐다. 새 이벤트는 만들어지지 않았다.
- 새 occurrence의 첫 투여 보고는 `PLAN_UNVERIFIED`만 반환했고, 겹친 두 번째 보고에는 `DUPLICATE_POSSIBLE`가 추가됐다. 실제 행위를 기록하지 못하게 차단하지 않았다.
- 계획 버전이 `USER_ENTERED_UNVERIFIED`인 합성 계획은 승인된 계획으로 표시되지 않았고, 평가에 `PLAN_UNVERIFIED`가 남았다.
- 시험용 occurrence advisory lock을 보유한 동안 인증 요청에 1초 `lock_timeout`을 설정했다. SQLSTATE `55P03`으로 제한 시간이 만료됐으며, 그 시점의 이벤트·멱등성 행은 모두 0건이었다. 잠금 해제 뒤 같은 키로 재시도하자 이벤트 1건과 멱등성 행 1건이 만들어졌다.

### 교착 상태

동일 occurrence에 대한 정상 RPC 경합에서는 교착 상태가 발생하지 않았다. 함수는 actor·operation·idempotency key 잠금을 먼저 취득하고 occurrence 잠금을 취득하는 순서로 동작한다. 이번 시험은 교착 상태를 인위적으로 만들지 않았으므로 애플리케이션의 별도 deadlock 재시도 정책까지 검증한 것은 아니다. 운영에서 SQLSTATE `40P01`을 만났을 때의 재시도 정책은 별도 결정이 필요하다. 검증된 범위는 occurrence lock 대기, 시간 초과, 부분 저장 없음 및 동일 키 재시도다.

## 5. RLS 및 권한 검증

- Pet Grant와 Household 멤버십이 없는 사용자는 다른 Household Pet을 RLS 조회해도 0건을 받았다.
- 관련 없는 사용자 C가 `record_health_event`를 호출하면 `FORBIDDEN`(SQLSTATE `42501`)으로 거부됐다.
- 사용자 B의 Pet Grant를 `REVOKED`로 바꾼 뒤 새 RPC를 제출하자 Pet 조회가 0건이었고 쓰기도 `FORBIDDEN`으로 거부됐다. 해당 요청의 이벤트와 idempotency 행은 생성되지 않았다.
- 같은 Household의 두 번째 Pet에 대한 B의 Grant를 테스트 목적으로 활성화한 뒤 키를 첫 Pet에서 두 번째 Pet으로 옮겨 재사용해도 멱등성 충돌로 거부됐다.
- 권한 철회 후 오프라인에서 만들어진 초안을 서버에 제출하는 경우의 핵심 서버 동작은 위 철회 이후 RPC 거부로 확인했다. 브라우저 IndexedDB 초안 처리 및 화면 상태는 Phase 1.2 범위 밖이어서 검증하지 않았다.

권한 철회와 쓰기가 정확히 동시에 진행되는 경합, 실제 브라우저 세션의 토큰 갱신·철회 반영 지연은 별도로 검증해야 한다.

## 6. 발견된 결함과 수정 내용

애플리케이션 코드, migration, Supabase 설정 또는 인프라 파일은 수정하지 않았다. Vector는 비인증 포트를 열어 해결하지 않고 CLI의 `-x vector,logflare` 옵션으로 제외했다. DB와 Docker 데이터는 삭제하지 않았다.

동시성 회귀 검증을 위해 로컬 DB에 합성 사용자·Household·Pet·Plan·Routine 및 Health Event를 생성했다. 시작 전 DB에는 사용자·Pet·Health Event가 각각 0건이었다. 이 합성 fixture는 현재 로컬 DB에 남아 있으며 실제 사용자나 임상 정보는 포함하지 않는다.

확인된 설계 한계는 다음과 같다.

- `safety_evaluations`는 `evidence_event_ids` 및 occurrence를 통해 Health Event와 추적 가능하다. `audit_log`는 각 이벤트 ID와 요청 키를 기록하지만 Evaluation ID를 직접 FK로 저장하지는 않는다. 현재 연결은 이벤트·요청을 통한 간접 추적이다.
- Vector를 제외하면 해당 로컬 실행에서 통합 로그/분석 수집을 사용할 수 없다.
- 동시성 실행은 실제 DB에서 수동으로 검증했으나, 두 연결을 동시에 띄우는 반복 가능한 자동 테스트는 아직 저장소에 추가하지 않았다.

## 7. 미검증 항목

- 실제 브라우저 UI에서 경고 표시, 오프라인 초안 및 서버 확정 상태 전환
- 네트워크 단절 후 재연결·동기화, 브라우저 저장소 손실, 재시도 큐
- 권한 철회와 쓰기의 동시 트랜잭션 경합 및 Auth 토큰 철회 반영 시간
- 정상 RPC 외부에서 만든 교착 상태와 SQLSTATE `40P01` 재시도
- Deadlock/statement timeout에 대한 클라이언트 표시 및 재시도 UX
- 이메일·Web Push·Notifications Worker의 중복 발송, 재시도 및 실패 처리
- 장기 부하, 다중 Pet 규모, 백업 복원, 데이터 삭제·내보내기
- Phase 1.1에서 통과했다고 보고된 Vitest·typecheck·lint·build는 이 검증 단계에서 재실행하지 않았다. 이번 단계에서 새로 실행한 DB 검증은 pgTAP 12/12 및 위의 직접 PostgreSQL 세션 검증이다.

## 8. Phase 1 최종 종료 판정

**CONDITIONAL GO**

Phase 1의 핵심 데이터 계약에 대한 로컬 DB 검증은 통과했다. Vector 없이도 DB 테스트가 안정적으로 통과했고, 독립 세션 동시 기록에서 두 이벤트 보존·중복 가능성 경고·멱등성·감사 및 평가 추적이 확인됐다. 권한 없는 쓰기와 순차 권한 철회 직후 쓰기도 거부됐다. 실제 임상 기준이나 용량은 만들거나 평가하지 않았다.

조건은 두 가지다. 첫째, 위 동시성·lock timeout·멱등성 시나리오를 CI 또는 로컬 DB 테스트에서 반복 가능한 자동 통합 테스트로 보강해야 한다. 둘째, 브라우저 오프라인·권한 철회 화면 상태는 Phase 2에서 서버 확정 여부와 분명히 구분해야 한다. 이 조건은 화면 개발 착수 전에 모든 기능을 구현할 것을 요구하지 않지만, 출시 전에는 완료돼야 한다.

## 9. Phase 2 착수 여부

**조건부 착수 가능**이다. Phase 2는 현재 서버 계약을 표시하는 UI 작업부터 시작할 수 있다. `PLAN_UNVERIFIED`, `MEAL_UNCONFIRMED`, `DUPLICATE_POSSIBLE`, 서버 확인 불가, 저장 실패 및 오프라인 초안 상태를 서로 혼동하지 않게 표현해야 한다. Safety Guard 경고는 투여 승인으로 표현하지 않고, 이미 발생한 행위의 사후 기록을 막지 않아야 한다. 자동화된 동시성 회귀 테스트와 실제 오프라인 UI 검증은 출시 조건으로 유지한다.
