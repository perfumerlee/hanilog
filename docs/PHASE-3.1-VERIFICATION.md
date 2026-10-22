# HaniLog — Phase 3.1 DB Integration & Safety Verification

**판정: NO-GO — Phase 3 종료 및 Phase 4 착수 불가**  
**검증 대상:** 현재 Windows 개발 세션의 로컬 Docker Desktop/Supabase와 Phase 3 migration  
**데이터:** 로컬 상태 확인에 한함. DB 초기화, migration 적용, 컨테이너·볼륨 삭제는 실행하지 않음.

## 1. Docker CLI 및 실행 환경

- Docker CLI는 설치되어 있고 현재 세션 PATH에서도 발견됐다: `C:\Users\leeta\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`.
- `docker.exe --version` 결과는 **29.9.1**이다. 그러므로 최초의 “CLI 탐색 실패”는 설치 파일 부재나 PATH 누락으로 재현되지 않았다.
- Docker context는 `desktop-linux`로 선택되어 있지만, CLI는 `npipe:////./pipe/dockerDesktopLinuxEngine`에 연결하지 못했다. `\\.\pipe\dockerDesktopLinuxEngine`와 `\\.\pipe\docker_engine` 모두 존재하지 않았다. 파이프가 없으므로 접근 제어 목록을 통한 ACL 거부인지 판별할 수 없으며, 이 결과는 단순한 권한 거부가 아닌 **엔진 파이프 미생성**을 가리킨다.
- 기존 `Docker Desktop.exe`를 실행했지만 Linux Engine이 준비되지 않았다. `docker info`의 Server 정보 조회와 컨테이너 목록 조회는 실패했다. 재설치, 서비스 설정 변경, 관리자 영구 설정 변경은 하지 않았다.
- `E:\Docker\WSL` 디렉터리는 존재한다. 현재 세션에서 하위 데이터 파일은 확인되지 않았으며 Engine이 응답하지 않아 Docker의 실제 데이터 루트 위치를 검증할 수 없었다.
- Docker 로그의 과거 기록만으로 이번 세션 실패 원인을 확정할 수 없었다. 현재 로그에는 이번 실패를 설명하는 확정적인 원인이 확인되지 않았다. WSL 호출 또한 실행 세션에서 `Wsl/E_ACCESSDENIED`를 반환했으나, 관리자 권한의 Windows 터미널에서 같은지 확인되지 않았다.

## 2. Supabase 및 저장 공간

- Supabase CLI **2.121.0**.
- `npx supabase status`는 선택된 Docker Linux Engine 파이프에 연결하지 못해 컨테이너 상태 검사에서 실패했다.
- `127.0.0.1:54322` 연결은 `ECONNREFUSED`였다. 로컬 PostgreSQL/API 서비스는 이번 검증 시 실행 중이 아니었다.
- migration 적용 목록을 DB와 대조할 수 없었다. Supabase는 프로젝트의 기존 데이터 및 컨테이너 상태를 확인하지 못했다.
- `supabase/config.toml`에서 Phase 2.1 이후 사용하던 Vector/Logflare 제외 여부를 확인할 수 있는 명시적인 설정은 발견되지 않았다. 실제 컨테이너 구성은 엔진이 없어 확인 불가다.
- C 드라이브 여유 공간은 확인 시 **약 1.39GB**, E 드라이브는 **약 653.39GB**였다. 현재 공간으로는 불필요한 이미지 다운로드 또는 전체 Supabase 초기화를 진행하지 않았다.
- `supabase db reset`은 실행하지 않았다. 기존 합성 fixture 보존 여부를 확인할 수 없는 상태에서 초기화나 migration을 시도하지 않았다.

## 3. Migration 사전 검토 및 변경

검토 파일: `supabase/migrations/202610210001_phase1_foundation.sql`, `supabase/migrations/202610210002_phase3_shared_care_routines.sql`, `supabase/tests/phase3_shared_care.test.sql`.

Phase 3 migration은 기존 테이블에 `care_routines.name`을 추가하고 초대·안전 확인 테이블, RPC, 트리거, Realtime publication 등록을 추가하는 형태다. 기존 Health Event 데이터를 삭제하거나 재작성하는 구문은 발견되지 않았다. 다만 실제 데이터와 적용된 스키마를 조회하지 못해 호환성과 데이터 보존을 DB에서 입증하지는 못했다.

정적 검토 중 적용 차단 결함을 발견해 migration을 최소 수정했다. `safety_acknowledgements` 생성 시 `(evaluation_id, pet_id)` 복합 외래키가 `safety_evaluations(id, pet_id)`를 참조하지만, 대상 복합 UNIQUE 제약이 원래 파일에서는 자식 테이블 생성 뒤에 선언되어 있었다. PostgreSQL은 외래키를 만들 때 참조 키가 이미 UNIQUE/PK여야 하므로 migration 적용이 실패할 수 있다. 복합 UNIQUE 제약을 자식 테이블 생성 전에 선언하도록 순서를 바꿨다. 이 수정은 **파일 정적 검토 수준**이며, migration apply나 롤백 검증은 수행하지 못했다.

`phase3_shared_care.test.sql`은 `plan(22)`와 22개의 assertion을 포함한다. 파일 검토만으로 실제 RLS·권한·함수 실행 통과를 판정하지 않았다.

## 4. DB, 권한 및 동시성 테스트

| 검증 | 결과 | 근거 |
|---|---|---|
| 기존 pgTAP 전체 회귀 | 미실행 | DB 접속 불가 |
| Phase 3 pgTAP | 미실행 | migration 적용 및 DB 접속 불가 |
| Household/Pet RLS 격리 | 미검증 | 실 DB 테스트 불가 |
| 초대 만료·재사용·거절·철회 | 미검증 | 실 DB 테스트 불가 |
| 의료진 범위 제한 | 미검증 | 로컬 DB 및 해당 두 사용자 세션 불가 |
| Routine 생성·수정·과거 버전 보존 | 미검증 | 실 DB 테스트 불가 |
| Safety Guard 중복 경고·미승인 계획 | 미검증 | 실 DB 테스트 불가 |
| 권한 철회 직후 조회·쓰기 거부 | 미검증 | 실 DB 테스트 불가 |
| `npm run test:db:concurrency` | 실패 | 독립 psql 세션을 열 Docker named pipe가 없음 |
| 동시 제출 2건·멱등 재시도·락·롤백·감사 이력 | 미검증 | 두 PostgreSQL 세션 실행 증거 없음 |

동시성 스크립트는 실제 실행을 시도했으나 Docker `desktop-linux` 파이프 연결 오류로 psql 세션을 시작하지 못했다. 따라서 이벤트 보존, 중복 가능성 경고, 멱등성 및 잠금에 성공했다고 보고하지 않는다.

## 5. Realtime 검증

보호자 A/B의 독립 세션으로 구독·갱신·서버 재조회·연결 복구·권한 철회 후 차단을 테스트하지 못했다. Supabase 서비스 자체가 실행되지 않았고, 브라우저 양쪽 세션도 준비되지 않았다. **전체 Realtime 검증 미완료**다.

## 6. 프런트엔드 회귀

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 통과 |
| `npm run lint` | 통과 |
| `npm test` | 통과 — 4개 파일, 19/19 테스트 |
| `npm run build` | 통과 |
| `PAGES_BASE_PATH=/hanilog/` 하위 경로 빌드 | 통과 — `/hanilog/assets/...` 및 manifest의 `start_url`, `scope`, icon 경로 확인 |

Pages 배포는 실행하지 않았다. UI의 실제 Supabase RPC, 권한 철회, 저장 실패/재시도 및 Realtime 동작은 브라우저 통합 테스트가 아니므로 검증 완료로 보지 않는다.

## 7. 결함 및 수정 내역

- **수정:** Phase 3 migration에서 composite FK가 참조할 UNIQUE 키의 선언 순서를 앞당겼다.
- **환경 차단:** Docker CLI는 PATH에 있었으나 Desktop Linux Engine 파이프가 생성되지 않았다. Supabase 54322도 연결을 거부했다.
- 추가 migration 수정이나 데이터 수정은 하지 않았다. 이번 정적 검토로 발견한 나머지 위험을 추측성으로 바꾸지 않았다.

## 8. 남은 위험 및 미검증 사항

- Docker Desktop/WSL의 현재 엔진 기동 실패 원인과 named pipe ACL.
- 로컬 Supabase 실제 컨테이너 상태, 적용 migration 목록 및 Vector/Logflare 설정.
- 수정한 Phase 3 migration의 PostgreSQL 적용 및 비파괴성.
- 모든 pgTAP/RLS, 실제 독립 세션 동시성·멱등성·롤백 검증.
- Realtime 두 사용자 세션의 전달·재연결·권한 철회 검증.
- 의료진 범위 제한은 별도 의료진 계정/허가 fixture를 통한 DB 테스트가 필요하다.

## 9. 최종 판정

**Phase 3 종료: NO-GO. Phase 4 착수: NO-GO.** 프런트엔드 정적 검사와 단위 테스트는 통과했으나, Phase 3의 새 DB 계약이 실제로 적용되거나 테스트되지 않았다. migration의 FK 순서 결함도 수정 후 DB 확인이 남아 있다. Docker Desktop의 Linux Engine을 정상화하고, 기존 DB를 보존한 상태에서 migration 적용·전체 pgTAP·RLS·실제 동시성·Realtime 검증을 모두 통과한 뒤 재판정해야 한다.
