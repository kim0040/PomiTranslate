# 쓰기 안전 모델 — 복구 기록(journal)과 중단 경계

> English summary at the end. 이 문서는 2026-10 Wave B(안전한 쓰기 트랜잭션) 구현을 설명한다. 원본 월드 쓰기는 항상 합성/복사본에서 baseline SHA-256으로 검증한다.

## 한눈에

월드에 무엇이든 쓰기 전에 앱은 (1) 바꿀 파일의 **현재 상태(해시·크기·없음 여부)를 기록**하고, (2) 원본을 **백업에 복사해 검증**하고, (3) 새 파일을 **백업 세트 안의 staging 폴더에 모두 만들어 둔 뒤**, (4) 단위(unit)별로 교체하며 디스크에서 다시 읽어 확인한다. 이 모든 단계는 백업 세트 안의 `journal.json` 한 파일에 남는다. 앱이 중간에 죽으면 다음 실행에서 `interruptedJobs`로 보이고, 사용자가 **되돌리기(rollback)** 또는 **현재 상태 유지(keep)** 를 직접 고른다. 자동으로 되돌리지 않는다.

## 파일과 위치

| 항목 | 위치 | 수명 |
| --- | --- | --- |
| 복구 기록 | `<백업 세트>/journal.json` (작업당 하나) | 그 백업 세트와 함께만 삭제된다. 정리되지 않은(unsettled) 세트는 삭제하지 않는다. 현재 백업을 지우는 기능은 없으며, 앞으로 만드는 삭제·보관 기능은 `mwt.journal.journal_state_of_set`로 이 규칙을 지켜야 한다. |
| 새 파일 임시 보관 | `<백업 세트>/staging/` | 쓰기가 끝나거나 중단 복구가 끝나면 지운다. |
| 충돌 격리 | `<백업 세트>/quarantine/<복구 id>/` | 사용자가 직접 확인 후 지운다. 덮어쓰지 않는다. |
| 복구 직전 백업 | 같은 저장소의 `…-recovery` 세트(자체 journal 보유) | 일반 백업 세트와 같다. |
| 외부 ZIP 잠금 | `<앱 데이터>/locks/<sha256(normcase(realpath))>.lock` | 영구 파일, 내용 없음. 잠금의 진실은 파일 존재가 아니라 커널 잠금이다. |
| 답변 기록 | 체크포인트 옆 `*.checkpoint.json.batches.jsonl` | 작업이 완료되거나 폐기될 때 함께 지운다. |

SQLite는 쓰지 않는다. `journal.json`은 매번 임시 파일 → `fsync` → 교체로 다시 쓰고(`seq`는 단조 증가), 파일 앞 4 KB에 `jobId`, `state`, `settled`가 있어 시작 화면은 파일 전체를 읽지 않고 상태를 본다. 기록이 손상되면 `needsAttention`으로 표시되고(상태 `invalid`), 그 기록으로는 어떤 파일도 건드리지 않는다.

## 상태

`preparing → prepared → committing → committed`(정상), 중간에 `partial`(일부만 검증됨), `rolled_back`, `recovering`(복구 중), `recovery_conflict`(외부 편집 때문에 일부를 건드리지 않음).

- `preparing`/`prepared`/`committing`/`recovering`에서 멈춘 작업은 **새 쓰기를 막는다**(`RECOVERY_REQUIRED`). `partial`과 `recovery_conflict`는 끝난 작업이므로 막지 않지만 목록에는 계속 보인다.
- 정리된(settled) 상태는 `committed`와 `rolled_back`, 그리고 `keep`으로 닫은 기록이다.

## 단위(unit)와 쓰기 순서

의존하는 파일은 한 단위로 묶는다: region + 그 `.mcc`, 월드 안 `resources.zip` 각각, 외부 팩 ZIP 각각. 각 대상은 월드(또는 외부 팩) 기준 상대 경로, 루트 종류(`world`/`external_pack`), **쓰기 전 상태**(`absent`/`sha256`/`size`), 백업 위치("absent" 포함), **의도한 쓰기 후 상태**, 결과(`pending`/`written`/`verified`/`failed`/`unknown`)를 가진다.

- **쓰기**: `.mcc` 먼저, region 나중. region이 아직 없는 `.mcc`를 가리키는 순간이 생기지 않게 한다.
- **되돌리기**: 이미 있던 `.mcc` → region → 새로 만든 `.mcc` 삭제 순. region이 사라지는(가리키던) 파일을 먼저 지우지 않기 위해서다.
- 교체는 같은 폴더의 임시 파일에 쓰고 `fsync`한 뒤 바꾸고(POSIX는 폴더도 `fsync`), **디스크에서 다시 읽어** 해시를 확인한 다음에야 `verified`로 적는다. 바꾼 뒤 폴더 `fsync`만 실패하면 `written`으로 남기고 오류(`WRITE_NOT_DURABLE`)는 그대로 보고한다. 성공으로 바꾸지 않는다.
- 변경 파일 수는 `verified`(또는 `written`)만 센다. 읽어 볼 수 없었던 파일은 `unknown`으로 보고한다.

## 쓰기 전 검사

1. 월드 쓰기 잠금 → Minecraft 세션 잠금 → 외부 팩 잠금(키 정렬 순)을 얻는다. 하나라도 사용 중이면 아무것도 바꾸지 않고 `WORLD_LOCKED` / `WORLD_IN_USE` / `TARGET_LOCKED`.
2. 스캔 때의 **파일별 해시와 파일 목록**을 다시 비교한다. 새 파일·사라진 파일·크기 변경이 있으면 `WORLD_CHANGED`로 시작 전에 멈춘다. 각 대상도 교체 직전에 다시 확인한다.
3. 전체 의도를 `journal.json`에 저장하고, 모든 백업을 쓰고 검증한 뒤 `prepared`로 바꾼다. 그 전에는 월드가 한 바이트도 바뀌지 않는다.

외부 ZIP은 파일 자체를 잠그지 않는다(다른 프로그램이 읽을 수 있어야 한다). 대신 앱 전용 잠금 파일을 검증부터 백업·교체·확인·복구까지 쥔다. 두 월드가 같은 ZIP을 고르면 두 번째 작업은 `TARGET_LOCKED`로 거부된다. 검증 후 ZIP이나 그 상위 폴더의 파일 식별자(`st_dev`/`st_ino`)가 바뀌면 거부한다.

## 중단 복구

시작 화면(`app.bootstrap`)은 읽기만 하고 `interruptedJobs`를 준다. 사용자가 `recovery.start {jobId, mode}`를 보내야만 무언가 바뀐다. 번역과 같은 보호(잠금 3종)를 쓰며 `JOURNAL_NOT_FOUND`, `JOURNAL_INVALID`도 돌려줄 수 있다.

복구는 **기록된 결과를 믿지 않고** 모든 대상의 현재 바이트를 다시 해시한다(`verified` 단위도 포함).

| 현재 상태 | 의미 | rollback | keep |
| --- | --- | --- | --- |
| 쓰기 전 상태와 같음 | 아직 안 바뀜 | 할 일 없음 | 그대로 |
| 쓰기 후 상태와 같음 | 이 작업이 쓴 것 | 백업으로 복원 | 그대로 두고 확정 |
| 둘 다 아님 | 누군가 따로 편집 | **건드리지 않음** → `RECOVERY_CONFLICT` | 그대로 |

충돌한 파일은 현재 바이트를 `quarantine/`에 복사하고(원본은 덮어쓰지 않는다) 결과에 파일별로 보고한다. 충돌한 단위는 통째로 건드리지 않는다. rollback은 **먼저 현재 상태를 담은 복구 백업을 만들고** 그 다음 쓰기 때문에, 복구 도중 죽어도 같은 방식으로 다시 복구할 수 있다(이전 시도의 기록은 닫힌다). 외부 ZIP은 사용자가 설정에서 고른 경로일 때만 복구한다. 기록이 스스로 접근 권한을 줄 수 없다.

복원(`restore.start`)도 같은 기계장치를 쓴다. 중단된 복원은 `kind: "restore"`로 목록에 나온다. 이 기록이 없는 이전 버전 백업은 그대로 목록에 나오고 복원할 수 있지만 `legacy: true`, `journalState: null`로 표시한다(변환하지 않는다).

## 유료 출력 보존

공급자 답변은 배치마다 `*.batches.jsonl`에 `fsync`와 함께 덧붙이고(보낸 요청, 받은 번역, 포기한 배치와 실패 코드), 이어서 하기는 이를 번역 캐시에 합친다. 월드를 쓰기 전에 앱이 죽어도 이미 낸 비용을 다시 내지 않는다. 마지막 줄이 잘려 있으면 그 줄만 무시한다.

## 보장하는 것

- 월드 안의 어떤 파일도, 백업이 디스크에서 검증되기 전에는 바뀌지 않는다.
- 각 대상은 임시 파일 교체로 쓴다. 한 파일이 반만 쓰인 상태로 남지 않는다. 디스크가 가득 차면(`DISK_FULL`) 이어지는 단위를 시작하지 않고 멈춘다.
- 중단되면 어떤 파일이 바뀌었는지는 기록과 해시로 **증거 기반**으로 판단한다. 모르면 `unknown`/충돌로 보고하고 성공이라 하지 않는다.
- 같은 월드·같은 외부 ZIP에 동시에 두 작업이 쓰지 않는다(위 잠금).
- 자동 되돌리기는 없다. 사용자가 고른 모드만 실행한다.

## 보장하지 않는 것

- **여러 파일에 걸친 정전 원자성**: Windows에는 폴더 `fsync`에 해당하는 동작이 없고, 이 앱은 여러 파일을 한 번에 원자적으로 바꾸지 못한다. 정전 직후 일부 단위만 반영될 수 있으며, 그것을 찾아 되돌리는 것이 위 복구다. POSIX 환경의 이 동작과 각 OS 네이티브 파일시스템에서의 증거는 **아직 없다**(합성 월드의 결함 주입 시험만 통과).
- 잠금을 무시하는 다른 프로그램(협조하지 않는 편집기, 동기화 도구)이 같은 순간 쓰는 경우. 교체 직전 해시 확인으로 대부분 발견하지만 완전히 막지는 못한다.
- 네트워크 드라이브처럼 잠금을 지원하지 않는 파일시스템. 이 경우 쓰기를 거부한다.
- 백업 세트가 있는 디스크 자체의 고장.
- 이전 버전이 만든 백업의 정확성(복원은 되지만 journal 근거는 없다).

## English summary

Every write job records its intent in `journal.json` inside its backup set, verifies all backups before touching the world, publishes units in dependency order (`.mcc` payloads before their region) and re-reads each file to confirm the bytes. A crashed job shows up in `app.bootstrap.interruptedJobs`; nothing is repaired automatically. `recovery.start {jobId, mode: rollback|keep}` re-hashes every target (never trusting recorded outcomes), restores only files that still hold this job's bytes, quarantines anything someone else edited (`RECOVERY_CONFLICT`, never overwritten) and takes a recovery backup first so an interrupted recovery can itself be recovered. External ZIPs are coordinated with app-private lock files, not by locking the ZIP. Not guaranteed: cross-file atomicity across power loss (no Windows directory flush; native-filesystem evidence is pending), writers that ignore locks, filesystems without locking. Provider answers are appended durably per batch so paid output survives a crash.
