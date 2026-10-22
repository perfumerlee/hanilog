# HaniLog — Phase 3.2 Docker Recovery & CI Database Verification

**판정: CONDITIONAL GO**  
**로컬 DB:** Phase 3 및 Phase 3.2 migration 적용 완료, 기존 합성 데이터 보존  
**GitHub Actions:** 워크플로 준비 완료, 저장소/실행 환경이 없어 실제 Action run은 미검증  
**Phase 4:** CI 실 실행 통과와 Realtime 권한 캐시 정책 확정 후 착수 가능

## 1. Docker Engine 장애와 복구

### 확인된 상태와 원인 범위

- Docker CLI는 PATH에 있었고 위치는 `C:\Users\leeta\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`, 버전은 **29.9.1**이었다.
- 첫 확인 당시 Docker Desktop/backend 프로세스가 없었고 `docker-desktop` WSL 배포판은 **Stopped**였다. `desktop-linux` context의 named pipe를 사용할 수 없어 Docker Server에 연결되지 않았다.
- 비승격 실행 세션에서는 WSL 호출이 `Wsl/E_ACCESSDENIED`를 반환하고, Linux Engine pipe도 보이지 않았다. 승인된 실행으로 기존 `docker-desktop` WSL2 배포판을 시작한 뒤 Docker Desktop을 실행하자 배포판이 Running으로 바뀌고 엔진에 연결됐다.
- 최종 `docker info` 결과: Docker Server **29.9.1**, `OSType=linux`. Linux 컨테이너 모드가 실제로 동작한다.
- 현재 restricted shell의 비승격 `docker` 호출은 named pipe 접근 거부를 반환할 수 있다. 승인된 실행 컨텍스트에서는 엔진과 Supabase 컨테이너가 정상 조회된다. 사용자 계정의 일반 PowerShell 권한 문제인지 Codex 샌드박스 경계인지는 이 세션만으로 분리할 수 없다.
- Windows 서비스 관리자 조회 및 이벤트 로그는 현재 권한/로그 채널 제약으로 확보하지 못했다. Lxss/Operational 채널은 이 컴퓨터에서 확인되지 않았고 Application 로그에서도 Docker/WSL 원인을 확정하는 항목을 찾지 못했다. Docker Desktop 로그에는 과거 backend 종료 기록은 있었으나 현재 기동 실패 원인을 특정하는 새 오류가 없었다.

따라서 **직접 확인된 즉시 원인은 Docker Desktop WSL 배포판과 Linux Engine이 중지되어 pipe가 준비되지 않았던 것**이다. 그 배포판이 처음 중지된 더 깊은 이유는 이벤트 로그 근거가 없어 확정하지 않는다. 복구 과정에서 재설치, 초기화, WSL 설정 변경, 관리자 영구 설정 변경, 재부팅은 하지 않았다.

### 저장 위치와 용량

- Docker Linux 데이터 VHDX: `E:\Docker\WSL\disk\docker_data.vhdx` (**약 10.61GB**)
- Docker WSL 메인 VHDX: `E:\Docker\WSL\main\ext4.vhdx` (**약 100.66MB**)
- Docker Engine 내부 `DockerRootDir`은 `/var/lib/docker`이며 이 Linux 데이터 디스크가 E 드라이브에 있다.
- 확인 시 C 드라이브 여유 공간 **약 1.31GB**, E 드라이브 **약 653.33GB**.
- 기존 이미지, 컨테이너, 볼륨, VHDX는 삭제하지 않았다.

## 2. Supabase 상태와 migration 적용

- Supabase CLI **2.121.0**. `supabase status`에서 `linked_project=null`을 확인했다. 모든 DB 명령은 `--local` 또는 로컬 프로젝트 대상으로 실행했다.
- 기존 Supabase 컨테이너는 DB, Auth, REST, Realtime, Storage, Kong, Studio 등 주요 서비스가 healthy 상태였다. Vector와 Analytics/Logflare 관련 컨테이너는 정지 목록에 있어 Phase 2.1 이후 제외 구성을 확인했다. CI에서도 `--exclude vector,logflare`를 사용한다.
- 기존 migration history는 `202610210001`까지만 적용되어 있었고 `202610210002`가 pending이었다.
- 적용 전 Phase 3 migration은 추가형 DDL/함수/정책/트리거/publication 변경이며 기존 Health Event/Pet/Household 삭제문이 없는지 검토했다. `safety_evaluations(id, pet_id)` UNIQUE 제약 순서 문제는 migration 적용 전 자식 테이블 생성보다 앞서도록 바로잡혀 있었다.
- 기존 합성 데이터 **Household 3, Pet 4, Health Event 14**를 확인한 뒤 `supabase migration up --local`로 미적용 migration만 적용했다. `db reset`은 실행하지 않았다.
- Phase 3 테스트에서 Household 철회 함수의 `select id` 조인이 모호한 컬럼 오류를 냈다. 기존 적용 migration을 다시 쓰지 않고 `202610220001_phase32_revoke_household_member_fix.sql` 후속 migration을 만들어 `pag.id`를 명시했고, `migration up --local`로 적용했다.
- 최종 migration 목록: `202610210001`, `202610210002`, `202610220001` 모두 적용.
- 검증 후에도 Household 3, Pet 4, Health Event 14로 기존 행 수가 유지됐고 Realtime 테스트용 계정 잔여 수는 0이었다.

## 3. pgTAP 및 RLS 결과

첫 pgTAP 시도에서 Phase 3 테스트의 만료 초대 fixture가 `expires_at > created_at` 제약을 어겼다. 테스트 fixture를 생성 시각 2일 전, 만료 시각 1일 전으로 고쳐 정합성을 맞췄다. 다음 실행에서는 Household 철회 함수의 모호한 컬럼 결함이 드러나 위 후속 migration으로 수정했다.

수정 후 `npx supabase test db` 결과 **2개 파일, 34/34 테스트 통과**:

- 기존 `database.test.sql`: 12 assertions 통과.
- `phase3_shared_care.test.sql`: 22 assertions 통과.
- 테스트에서 초대 이메일 검증·수락·재사용 차단·만료, Pet grant 조회, 미승인 개인 계획의 `PLAN_UNVERIFIED`, 선행 식사 미확인/예외, 수행 기록의 시각 보존, Routine 새 버전 및 과거 슬롯 보존, 멤버 철회와 이후 조회·쓰기 거부를 검증했다.
- 이 두 pgTAP 파일에는 전용 의료진 사용자 범위 테스트가 없다. 의료진 신원·범위 정책은 별도 테스트가 남아 있다.

## 4. 동시성 및 멱등성

`npm run test:db:concurrency` 통과. 실행 로그에서 서로 다른 PostgreSQL backend PID **293과 306**을 확인했고, B 세션이 A가 잡은 occurrence advisory lock을 기다린 증거가 남았다.

- 두 보호자의 서로 다른 실제 발생 시각 이벤트 2건 보존.
- 두 이벤트와 Safety Evaluation 및 감사 행 보존.
- 두 번째 응답에서 `DUPLICATE_POSSIBLE` 반환.
- 동일 멱등 키 재전송은 원래 event ID 반환, 세 번째 event 미생성.
- 권한 철회 후 쓰기 `FORBIDDEN`, Pet/event RLS 조회 0건.
- 테스트 종료 시 이번 실행에서 생성한 합성 fixture ID만 정리 완료.

동시성 실행은 단순 순차 호출이 아니며, 두 독립 psql 세션의 PID와 lock 대기 로그가 증거다.

## 5. Realtime 연결 및 권한 철회

반복 가능한 `npm run test:db:realtime`을 추가하고 실제 로컬 Auth/API/Realtime에 두 개의 독립 인증 클라이언트로 실행했다. 실사용자나 처방정보는 사용하지 않았다.

- A가 합성 Household/Pet을 만들고 B를 초대·승인.
- B가 권한이 있는 동안 Pet을 읽고 Health Event Realtime 채널에 구독.
- A의 Health Event가 B에게 실시간 전달됨.
- A가 B의 Pet grant를 철회한 뒤 B의 서버 Health Event 조회는 0건.
- 철회 후 A가 새 이벤트를 제출해도 관찰한 테스트 시간 동안 B에게 전달되지 않음.
- 테스트 계정·기록·초대 등 해당 실행에서 생성한 데이터는 정리했고 leftover 계정 0건을 확인.

**한계:** 이 로컬 테스트는 즉시 철회 후 짧은 관찰 구간을 검증했다. Supabase 공식 문서는 Realtime 권한 정책 캐시가 채널 연결 동안 유지될 수 있고, 이미 연결된 클라이언트가 새 JWT를 받거나 기존 JWT가 만료되기 전까지 취소된 권한이 반영되지 않을 수 있다고 설명한다. 따라서 한 번의 로컬 테스트만으로 모든 장기 연결에서 즉각적 차단을 보장한다고 결론 내리면 안 된다. [Supabase Realtime Authorization 문서](https://supabase.com/docs/guides/realtime/authorization)

## 6. GitHub Actions DB 검증 준비

신규 `.github/workflows/database-tests.yml`은 Ubuntu runner에서 pull request와 `main` push에 실행되도록 구성했다.

1. 기존과 동일한 SHA 고정 checkout/setup-node Actions, `npm ci`.
2. package-lock이 고정한 Supabase CLI **2.121.0**을 설치하고 버전 일치 assertion.
3. `supabase start --exclude vector,logflare`로 runner 안의 빈 로컬 테스트 DB를 기동하고 repository migrations를 적용.
4. `supabase test db`로 pgTAP 실행.
5. `npm run test:db:concurrency`로 두 PostgreSQL 세션 회귀 실행.
6. 두 독립 Auth 사용자로 `npm run test:db:realtime` 실행.

동시성 스크립트는 기존 PowerShell 테스트 로직을 유지한다. 새 `scripts/run-concurrency-test.mjs`가 Windows에서는 `powershell`, 비-Windows에서는 `pwsh`를 선택해 동일 테스트를 실행한다. Ubuntu runner에 기본 제공되는 PowerShell 환경을 대상으로 작성했지만 GitHub runner에서 실제 실행하지는 않았다.

워크플로에는 `supabase link`, 원격 DB URL, service key, 배포 단계가 없다. Stack 시작 로그는 runner 임시 파일로 보내고 출력하지 않으며, Realtime 테스트에는 로컬 CLI가 반환한 URL과 공개 publishable key만 `GITHUB_OUTPUT`으로 전달한다. 실제 사용 데이터는 만들지 않는다.

**실제 GitHub Actions 실행: 미검증.** 현재 작업 디렉터리는 Git repository가 아니며(`git status`가 `not a git repository` 반환), 연결된 원격 저장소/Actions 실행 권한이 없어 workflow dispatch를 할 수 없었다. 파일 준비까지만 완료했다. Supabase의 공식 CI 안내도 로컬 stack 시작 후 `supabase test db` 실행 흐름을 사용한다: [Testing your database in GitHub Actions](https://supabase.com/docs/guides/deployment/ci/testing).

## 7. 프런트엔드 회귀

- `npm run typecheck` — 통과.
- `npm run lint` — 통과.
- `npm test` — 통과, **4개 파일·19/19 테스트**.
- `npm run build` — 통과, PWA 파일 생성.
- GitHub Pages 배포는 진행하지 않았다.

## 8. 변경 파일과 남은 위험

### 변경 파일

- `.github/workflows/database-tests.yml`
- `package.json`
- `scripts/run-concurrency-test.mjs`
- `scripts/test-realtime.mjs`
- `supabase/tests/phase3_shared_care.test.sql`
- `supabase/migrations/202610220001_phase32_revoke_household_member_fix.sql`
- `docs/PHASE-3.2-VERIFICATION.md`

### 남은 위험/미검증

- Windows 이벤트 로그 접근 제한으로 Docker Desktop이 처음 중지된 깊은 원인을 확인하지 못함. 비승격 Codex shell의 named pipe 접근 거부가 실제 사용자 PowerShell에도 재현되는지 별도 확인 필요.
- GitHub-hosted Ubuntu에서 workflow, `pwsh` wrapper, fresh Supabase migration stack을 실행하지 못함.
- 의료진 별도 계정의 Pet 공유 범위에 대한 pgTAP 검증 부재.
- Supabase 문서가 설명하는 장기 Realtime 권한 캐시와 세션 갱신/채널 해제 정책을 제품 계약으로 확정해야 함. 이 보고서의 2초 관찰 테스트는 이 위험을 해소하지 않는다.
- C 여유 공간 1.31GB이므로 Windows에서 로컬 Supabase 이미지 대량 갱신은 피하고, 불필요한 Docker 데이터 삭제 대신 CI 검증을 우선하는 편이 안전하다.

## 9. 판정 및 Phase 4

**Phase 3.2: CONDITIONAL GO.** 로컬 Phase 3 migration, pgTAP/RLS, 두 세션 동시성, Realtime의 기본 허용/철회 시나리오와 프런트엔드 회귀는 통과했다. 기존 합성 데이터는 보존됐다.

**Phase 4: 조건부 착수.** GitHub Actions에서 이 워크플로를 실제 한 번 실행해 통과를 확인하고, 장기 연결 Realtime 세션의 권한 철회 캐시 동작 및 토큰/채널 갱신 정책을 승인하기 전에는 공유 의료기록 접근을 확장하는 Phase 4 작업을 시작하지 않는다.
