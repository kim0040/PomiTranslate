# 쓰기 안전 모델 — 복구 기록(journal)과 중단 경계

> English summary at the end. 이 문서는 2026-10 Wave B(안전한 쓰기 트랜잭션) 구현을 설명한다. 원본 월드 쓰기는 항상 합성/복사본에서 baseline SHA-256으로 검증한다.

## 한눈에

월드에 무엇이든 쓰기 전에 앱은 (1) 바꿀 파일의 **현재 상태(해시·크기·없음 여부)를 기록**하고, (2) 원본을 **백업에 복사해 검증**하고, (3) 새 파일을 **백업 세트 안의 staging 폴더에 모두 만들어 둔 뒤**, (4) 단위(unit)별로 교체하며 디스크에서 다시 읽어 확인한다. 이 모든 단계는 백업 세트 안의 `journal.json` 한 파일에 남는다. 앱이 중간에 죽으면 다음 실행에서 `interruptedJobs`로 보이고, 사용자가 **되돌리기(rollback)** 또는 **현재 상태 유지(keep)** 를 직접 고른다. 자동으로 되돌리지 않는다.

## 파일과 위치

| 항목 | 위치 | 수명 |
| --- | --- | --- |
| 복구 기록 | `<백업 세트>/journal.json` (작업당 하나) | 그 백업 세트와 함께만 삭제된다. 정리되지 않은(unsettled) 세트는 삭제하지 않는다. 현재 백업을 지우는 기능은 없으며, 앞으로 만드는 삭제·보관 기능은 `mwt.journal.journal_state_of_set`로 이 규칙을 지켜야 한다. |
| 새 파일 임시 보관 | `<백업 세트>/staging/` | 쓰기가 끝나거나 중단 복구가 끝나면 지운다. |
| 충돌 격리 | `<백업 세트>/quarantine/<복구 id>/<루트 종류>/…` | 사용자가 직접 확인 후 지운다. 월드 파일은 월드 기준 상대 경로, 외부 ZIP은 `<sha256(정규화한 대상 경로)[:16]>-<파일명>`으로 구분하므로 이름이 같은 두 ZIP이 충돌하지 않는다. 격리 사본은 배타적으로 만들며 이미 있는 파일을 자르거나 덮어쓰지 않는다(내용이 같으면 그대로 두고, 다르면 번호를 붙인다). |
| 월드별 세대 카운터 | `<저장소>/world-state.json` = `{worldKey, generation, lastSettledJobId}` | 기록을 만들 때 월드 잠금 아래에서 1 올린다. 같은 월드의 모든 저장소 기록 중 가장 큰 세대와 비교해 더 큰 값을 쓰므로 백업을 지워도 되돌아가지 않는다. |
| 복구 직전 백업 | 같은 저장소의 `…-recovery` 세트(자체 journal 보유) | 일반 백업 세트와 같다. |
| 외부 ZIP 잠금 | `<앱 데이터>/locks/<sha256(normcase(realpath))>.lock` | 영구 파일, 내용 없음. 잠금의 진실은 파일 존재가 아니라 커널 잠금이다. |
| 답변 기록 | 체크포인트 옆 `*.checkpoint.json.batches.jsonl` | 작업이 완료되거나 폐기될 때 함께 지운다. |

SQLite는 쓰지 않는다. `journal.json`은 매번 임시 파일 → `fsync` → 교체로 다시 쓰고(`seq`는 단조 증가), 파일 앞 4 KB에 `jobId`, `state`, `settled`, `unitsOpen`, `generation`, `worldKey`가 있어 시작 화면은 파일 전체를 읽지 않고 상태를 본다. 헤더가 `committed`라도 `unitsOpen`이 0이 아니거나 없으면(옛 기록) 전체를 읽어 모든 단위가 `verified`인지 확인하고, 아니면 `failed`로 목록에 올린다. 기록이 손상되면 `needsAttention`으로 표시되고(상태 `invalid`), 그 기록으로는 어떤 파일도 건드리지 않는다.

## 상태와 정산(reconcile) 게이트

`preparing → prepared → committing → committed`(정상), 중간에 `partial`(일부만 검증됨), `recovering`(복구 중), `recovery_conflict`(외부 편집·불일치 때문에 일부를 건드리지 않음), 그리고 닫힌 상태 `rolled_back`, `kept`(현재 상태를 확인하고 유지), `superseded`(같은 작업을 이어한 새 작업이 대신함).

- **정리된(settled) 상태는 `committed`(모든 단위가 `verified`일 때만), `rolled_back`, `kept`, `superseded` 넷뿐이다.** `partial`과 `recovery_conflict`를 포함한 나머지는 모두 **정리되지 않은(unsettled)** 상태이며, 그 월드에 대한 **모든 새 쓰기를 막는다**: 새 번역, 다른 작업의 이어하기, 복원(`restore.start`), 다른 기록의 복구(`recovery.start`). 코드는 `RECOVERY_REQUIRED`이고 막는 작업 id 목록(`jobIds`)이 함께 간다.
- 게이트는 월드 잠금 아래에서 그 월드의 기록이 있을 수 있는 **모든 저장소**를 본다: 앱 데이터의 월드별 저장소(대소문자만 다른 경로 키 포함), 설정한 백업 위치, 월드 안의 옛 `.pomi-backups`. 월드를 알 수 없는 손상된 기록은 그 월드의 저장소에 있을 때만 막는다.
- 막지 않는 것은 자기 작업 가족뿐이다: 복구 시도(`parentJobId`)는 부모와 같은 가족이고, 자기 백업 세트를 `restore`하는 것은 그 작업을 되돌리는 방법이므로 자기 기록에 막히지 않는다(복원 후 모든 파일이 쓰기 전 상태로 다시 해시되면 기록을 `rolled_back`으로 닫는다).
- `interruptedJobs` 항목은 `state`(`preparing|prepared|committing|partial|recovery_conflict|recovering|failed`)와 `blocking: true`를 가진다. `failed`는 헤더는 `committed`인데 `verified`가 아닌 단위가 있거나 기록이 손상된 경우다.

### 부분 완료와 이어하기

취소·디스크 부족 등으로 멈춘 번역은 `partial`이고 목록에 나오며 새 쓰기를 막는다. **같은 작업을 이어하는 것만** 이 기록을 지나갈 수 있다. 이어하기는 먼저 옛 기록에 Keep 검사(아래)를 읽기 전용으로 적용한다. 통과하면 새 작업이 자기 백업 세트와 기록(`supersedes: <옛 id>`)을 만들고, 그 **의도가 디스크에 저장된 다음에** 옛 기록을 `superseded`(`supersededBy: <새 id>`)로 닫는다. 실패하면 `RECOVERY_REQUIRED`로 거부한다. 따라서 이어하기는 새 백업 세트를 만든다(예전처럼 같은 세트를 이어 쓰지 않는다). 남은 쓸 일이 없어 새 기록이 생기지 않으면 옛 기록은 `kept`로 닫는다.

### 오래된 기록 거부(세대)

기록마다 월드별 `generation`이 있다. `recovery.start`는 같은 월드에 **더 큰 세대의 기록이 있고 그것이 `rolled_back`이 아니면** `JOURNAL_SUPERSEDED`로 거부한다(가족 관계의 기록은 제외). 해시가 우연히 같다는 사실만으로는 어떤 기록도 파일의 주인이 되지 않는다. `superseded`로 닫힌 기록도 같은 코드로 거부한다.

## 단위(unit)와 쓰기 순서

의존하는 파일은 한 단위로 묶는다: region + 그 `.mcc`, 월드 안 `resources.zip` 각각, 외부 팩 ZIP 각각. 각 대상은 월드(또는 외부 팩) 기준 상대 경로, 루트 종류(`world`/`external_pack`), **쓰기 전 상태**(`absent`/`sha256`/`size`), 백업 위치("absent" 포함), **의도한 쓰기 후 상태**, 결과(`pending`/`written`/`verified`/`failed`/`unknown`)를 가진다.

- **쓰기**: `.mcc` 먼저, region 나중. region이 아직 없는 `.mcc`를 가리키는 순간이 생기지 않게 한다.
- **되돌리기**: 이미 있던 `.mcc` → region → 새로 만든 `.mcc` 삭제 순. region이 사라지는(가리키던) 파일을 먼저 지우지 않기 위해서다.
- 교체는 같은 폴더의 임시 파일에 쓰고 `fsync`한 뒤 바꾸고(POSIX는 폴더도 `fsync`), **디스크에서 다시 읽어** 해시를 확인한 다음에야 `verified`로 적는다. 바꾼 뒤 폴더 `fsync`만 실패하면 `written`으로 남기고 오류(`WRITE_NOT_DURABLE`)는 그대로 보고한다. 성공으로 바꾸지 않는다.
- 변경 파일 수는 `verified`(또는 `written`)만 센다. 읽어 볼 수 없었던 파일은 `unknown`으로 보고한다.
- **실제로 쓴 결과는 기록 저장과 별개로 메모리에 먼저 남는다.** 교체가 끝나는 즉시 그 파일을 `written`/`unknown` 목록에 넣고, 이어서 기록을 저장한다. 저장이 실패하면(디스크 가득, EIO) 더 이상 대상을 게시하지 않고 `JOURNAL_WRITE_FAILED`(디스크 가득이면 `DISK_FULL`)로 멈추며, 이미 게시한 파일은 결과의 `changedFiles`와 `unknownOutcomes`에 그대로 남는다. 첫 파일의 증거가 뒤의 저장 실패로 사라지지 않는다. 기록은 마지막으로 저장된 상태(열린 상태)로 남아 복구 대상이 된다.

## 쓰기 전 검사

1. 월드 쓰기 잠금 → Minecraft 세션 잠금 → 외부 팩 잠금(키 정렬 순)을 얻는다. 하나라도 사용 중이면 아무것도 바꾸지 않고 `WORLD_LOCKED` / `WORLD_IN_USE` / `TARGET_LOCKED`.
2. 스캔 때의 **파일별 해시와 파일 목록**을 다시 비교한다. 새 파일·사라진 파일·크기 변경이 있으면 `WORLD_CHANGED`로 시작 전에 멈춘다. 이 검사와 아래 식별자·해시 검사는 `backup` 설정과 무관하게 항상 실행된다.
3. 전체 의도를 `journal.json`에 저장하고, 모든 백업을 쓰고 검증한 뒤 `prepared`로 바꾼다. 그 전에는 월드가 한 바이트도 바뀌지 않는다.
4. **백업은 항상 켜져 있다.** `backup=false` / `--no-backup`은 받아들이지만 월드 쓰기에서는 무시한다. 결과에 경고 코드 `backup_always_on`이 한 번 붙고 CLI는 안내를 출력한다. 백업 세트가 없으면 쓰기를 되돌릴 수 없기 때문이다.
5. **대상 식별자 고정.** 계획은 검증한 각 대상의 `st_dev`/`st_ino`(Windows는 파일 인덱스)·크기·`mtime_ns`와 그 **상위 폴더**의 식별자를 기록에 저장한다. 번역·복원·복구 모두 잠금과 백업을 마친 뒤 **각 대상을 쓰기 직전에** 두 식별자를 다시 확인하고, 다르면 새 기준을 다시 잡지 않고 거부한다: 월드는 `WORLD_CHANGED`, 외부 ZIP은 `TARGET_CHANGED`. 같은 바이트의 다른 파일(교체)이나 바뀐 폴더도 걸러진다. 이것은 협조하지 않는 프로그램을 **완전히 막지는 못한다**(확인과 교체 사이의 짧은 틈이 남는다).

외부 ZIP은 파일 자체를 잠그지 않는다(다른 프로그램이 읽을 수 있어야 한다). 대신 앱 전용 잠금 파일을 검증부터 백업·교체·확인·복구까지 쥔다. 두 월드가 같은 ZIP을 고르면 두 번째 작업은 `TARGET_LOCKED`로 거부된다. 검증 후 ZIP이나 그 상위 폴더의 파일 식별자(`st_dev`/`st_ino`)가 바뀌면 거부한다.

## 중단 복구

시작 화면(`app.bootstrap`)은 읽기만 하고 `interruptedJobs`를 준다. 사용자가 `recovery.start {jobId, mode}`를 보내야만 무언가 바뀐다. 번역과 같은 보호(잠금 3종)를 쓰며 `JOURNAL_NOT_FOUND`, `JOURNAL_INVALID`도 돌려줄 수 있다.

복구는 **기록된 결과를 믿지 않고** 모든 대상의 현재 바이트를 다시 해시한다(`verified` 단위도 포함). 다른 정리되지 않은 작업이 같은 월드에 있으면 `RECOVERY_REQUIRED`, 더 새로운 작업이 있으면 `JOURNAL_SUPERSEDED`로 거부한다.

| 현재 상태 | 의미 | rollback | keep |
| --- | --- | --- | --- |
| 쓰기 전 상태와 같음 | 아직 안 바뀜 | 할 일 없음 | 그대로 |
| 쓰기 후 상태와 같음 | 이 작업이 쓴 것 | 백업으로 복원 | 그대로 두고 확정 |
| 둘 다 아님 | 누군가 따로 편집 | **건드리지 않음** → `RECOVERY_CONFLICT`(없어졌으면 `MISSING`, 읽을 수 없으면 `UNREADABLE`) | 충돌로 보고 |

**Keep은 확인만 한다.** 파일을 쓰지 않는다. 단위마다 모든 대상이 **같은 쪽**에 있어야 한다: 전부 쓰기 후 상태이거나 전부 쓰기 전 상태(새로 만든 파일의 없음도 쓰기 전 쪽)다. 한 단위 안에서 쪽이 섞여 있으면(예: 새 `.mcc`와 옛 region) 해시가 각각 알려진 값이어도 `UNIT_INCONSISTENT`다. region + `.mcc` 단위는 추가로 영향받는 각 청크의 NBT를 region 리더로 읽어 보고, 읽히지 않으면 같은 코드로 거부한다. 충돌이 있으면 읽을 수 있는 충돌 바이트를 `quarantine/`에 복사한 뒤 기록을 `recovery_conflict`(정리되지 않음)로 두고 결과 `state: "recovery_conflict"`와 파일별 코드를 돌려준다. 사용자가 명시적으로 `acceptConflicts: true`를 보낼 때만 충돌을 기록(`acceptedConflicts`)하고 `kept`로 닫는다(격리는 그 전에 이미 한다).

**Rollback은 충돌한 대상을 덮어쓰지 않는다.** 충돌한 단위는 통째로 건드리지 않고, 충돌이 하나라도 남으면 기록은 `recovery_conflict`로 남는다(성공으로 닫지 않는다). 충돌한 파일은 현재 바이트를 `quarantine/`에 복사하고 결과에 파일별로 보고한다. rollback은 **먼저 현재 상태를 담은 복구 백업과 자식 기록(`kind: "recovery"`, `parentJobId`)을 만들고** 그 다음 쓰기 때문에 복구 도중 죽어도 같은 방식으로 다시 복구할 수 있다. 실패하거나 일부만 한 복구 자식 기록은 **`committed`로 표시하지 않는다.** 부모가 `rolled_back`/`kept`로 닫힌 뒤에 자식의 모든 대상을 다시 해시해 부모가 정한 상태와 같다는 것이 확인된 자식만 `superseded`로 닫고, 그렇지 않은 자식은 목록에 남는다. 복구가 끝나면 이 작업의 대상 옆에 죽은 쓰기가 남긴 임시 파일(`.<대상 이름>.….tmp`)과 기록 폴더의 임시 파일을 지운다. 외부 ZIP은 사용자가 설정에서 고른 경로일 때만 복구한다. 기록이 스스로 접근 권한을 줄 수 없고, 복구 때도 쓰기 직전에 분류한 시점의 식별자(`TARGET_CHANGED`)를 다시 확인한다.

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

Every write job records its intent in `journal.json` inside its backup set, verifies all backups before touching the world (backups cannot be switched off for world writes: `backup=false` is ignored with the warning `backup_always_on`), publishes units in dependency order (`.mcc` payloads before their region) and re-reads each file to confirm the bytes. Just before each publish the target and its folder are checked against the identity captured at plan time (`WORLD_CHANGED`, `TARGET_CHANGED` for external ZIPs). A job is settled only as `committed` (all units verified), `rolled_back`, `kept` or `superseded`; every other state, `partial` and `recovery_conflict` included, blocks every new writer of that world in every known store (`RECOVERY_REQUIRED` with the blocking `jobIds`); only a resume of the same job passes, after a verify-only Keep check, and it supersedes the old record. A record that a newer job has passed is refused (`JOURNAL_SUPERSEDED`). A crashed job shows up in `app.bootstrap.interruptedJobs` (with `state` and `blocking`); nothing is repaired automatically. `recovery.start {jobId, mode: rollback|keep, acceptConflicts?}` re-hashes every target (never trusting recorded outcomes), restores only files that still hold this job's bytes, quarantines anything someone else edited (never overwritten) and takes a recovery backup first so an interrupted recovery can itself be recovered. Keep only verifies: a unit whose targets are on different sides, or whose chunks no longer parse, is `UNIT_INCONSISTENT` and the job stays open (`recovery_conflict`) unless the user explicitly accepts the conflicts. A recovery attempt that failed is never marked committed; it is retired as `superseded` only after its files were re-hashed against the settled parent. External ZIPs are coordinated with app-private lock files, not by locking the ZIP. Not guaranteed: cross-file atomicity across power loss (no Windows directory flush; native-filesystem evidence is pending), writers that ignore locks, filesystems without locking. Provider answers are appended durably per batch so paid output survives a crash.
