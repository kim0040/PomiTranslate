# 빌드·패키징 안내

sidecar(번역 코어) 패키징, Rust shell의 프로세스 감독, macOS 서명 절차, 로컬 gate를 정리합니다. 명령 모음은 [개발·빌드 안내](development.md)에 있습니다.

## 프로세스 역할

역할은 두 가지뿐이며 상주 서비스는 없습니다.

- 짧은 질의(설정·bootstrap·estimate 등): 요청마다 코어를 한 번 띄우고 끝나면 종료합니다 (query lane).
- 작업(scan·translate·restore·recovery·backups 정리): 감독되는 자식 프로세스 하나가 작업 하나를 맡습니다 (job lane). 같은 시점에 활성 코어는 하나입니다.

작업 lane 요청: `scan.start`, `translate.start`, `translate.resume`, `restore.start`, `recovery.start`, `jobs.recover`, `backups.delete`, `backups.prune`. 그중 `scan.start`를 뺀 나머지는 월드를 쓰는 요청입니다.

## sidecar 폴더 (PyInstaller onedir)

`pnpm sidecar:build`는 `build/sidecar/dist/pomi-sidecar/`를 만듭니다.

```
pomi-sidecar/
  pomi-sidecar[.exe]      # 시작 파일
  _internal/              # Python 런타임, 확장 모듈, 라이브러리
```

- 실행 시 임시 폴더에 풀지 않으므로 Shell이 띄운 프로세스가 곧 코어입니다. 그래서 프로세스 트리를 감독할 수 있습니다.
- `src-tauri/tauri.conf.json`의 `bundle.resources`가 이 폴더를 설치본의 resource 폴더 아래 `pomi-sidecar/`로 넣습니다. `externalBin`은 쓰지 않습니다.
- Rust는 `resource_dir()/pomi-sidecar/pomi-sidecar[.exe]`를 찾습니다. 한글·공백이 든 설치 경로를 단위 테스트로 확인합니다.
- 개발 빌드에서만 `POMI_SIDECAR_DEV=python`이면 `python -X utf8 -u packaging/pomi_desktop.py`를 실행하고, 아니면 위 build 폴더를 찾습니다. release 빌드는 이 변수를 무시합니다.
- build 폴더는 Git에 넣지 않습니다. `cargo`/`tauri build`가 resource 폴더 존재를 요구하므로 `pnpm verify:local`은 없으면 `PLACEHOLDER.txt`만 든 폴더를 만듭니다. `pnpm sidecar:build`는 이 폴더를 지우고 다시 만듭니다. release 프로필의 `build.rs`는 실제 시작 파일이 없으면 실패합니다 (`POMI_ALLOW_MISSING_SIDECAR`로 해제).
- 빌드 도구 버전은 `requirements-build.txt`에 고정합니다. 설치된 PyInstaller가 다르면 빌드가 멈춥니다. POSIX에서는 빌드 스크립트가 시작 파일을 0755로 맞춥니다.
- 빌드가 끝나면 코어를 stdin 없이 한 번 띄워 `system.hello`를 확인하고, 폴더 안의 네이티브 바이너리 목록을 `build/sidecar/nested-binaries.json`에 씁니다 (`pnpm sidecar:nested`로 목록만 다시 생성).

## 프로세스 감독

Rust(`core_process*.rs`, `sidecar.rs`)가 코어를 `tokio::process` 위에서 감독합니다.

| OS | 방식 |
| --- | --- |
| Windows | 자식마다 Job Object(`KILL_ON_JOB_CLOSE`). `CREATE_SUSPENDED`로 만들고 `AssignProcessToJobObject` 후 `ResumeThread`하므로 job 밖에서 코드가 돌지 않습니다. 모든 API 결과를 검사하고 실패하면 자식을 끝낸 뒤 오류를 냅니다(fail closed). 끝내는 `TerminateProcess`의 결과도 검사해 최대 5번 다시 시도하고, 성공하면 프로세스가 사라질 때까지 기다립니다(reap). 끝낼 수 없으면 로그에 남기며, 그 자식은 한 번도 재개되지 않은 채 멈춰 있습니다. job 핸들은 상속되지 않고, 상속되는 핸들은 파이프 3개로 제한합니다. 앱이 죽으면 마지막 핸들이 닫혀 트리 전체가 끝납니다. |
| Linux | 새 프로세스 그룹. 강제 종료는 `killpg(SIGKILL)`. `PR_SET_PDEATHSIG`를 걸고 부모가 이미 바뀌었는지 다시 확인합니다. |
| macOS | 프로세스 그룹 + `killpg`. `PDEATHSIG`가 없으므로 앱이 사라지면 stdin EOF에 의존합니다. |

**개발 모드 인터프리터.** 개발 모드는 `python` 같은 이름만으로 코어를 시작합니다. `CreateProcessW`는 정확한 파일을 요구하므로 Windows 쪽은 시작 전에 이름을 절대 경로로 풉니다. 디렉터리가 없는 이름은 `PATH`(자식 환경에 `PATH`를 덮어쓰면 그 값)를 순서대로 찾고, 확장자가 없으면 `PATHEXT` 중 `CreateProcessW`가 직접 시작할 수 있는 `.exe`/`.com`을 붙입니다. 스크립트(`.cmd`/`.bat`)는 프로그램이 아닙니다. 못 찾으면 추측하지 않고 시작 실패입니다. Microsoft Store의 실행 별칭(reparse point)은 파일로 인정합니다.

**stdin EOF 계약.** 코어가 지켜야 하는 정확한 약속이며 Rust의 안전은 이 약속에 기대지 않습니다(Rust는 항상 프로세스 트리를 직접 끝냅니다). 약속이 지켜지지 않으면 macOS처럼 `PDEATHSIG`가 없는 곳에서는 부모가 사라진 뒤 코어가 계속 쓰기를 할 수 있으므로 아래 내용을 코어 쪽 변경에서 그대로 구현·검증해야 합니다.

1. 코어는 stdin 읽기와 별개로 EOF를 감시하는 스레드(watcher)를 둡니다. 요청 처리기가 막혀 있어도 EOF는 감지되어야 합니다.
2. EOF를 보면 즉시 협력적 취소를 요청합니다(취소 파일을 쓴 것과 같은 효과). 월드를 쓰는 작업은 현재 단위(예: 한 파일·한 chunk)를 마친 뒤 안전하게 멈추고 journal을 일관된 상태로 둡니다.
3. EOF를 본 뒤 **10초 안에 프로세스가 종료**해야 합니다. 협력적 취소가 그 안에 끝나지 않으면 provider 호출 등으로 막힌 스레드를 기다리지 말고 `os._exit`로 즉시 종료합니다(종료 코드는 0이 아니어도 됩니다). 새 작업을 시작하거나 새 provider 호출을 만들면 안 됩니다.
4. 정상 종료 시의 같은 EOF(요청이 끝나 Rust가 stdin을 닫는 경우)는 취소가 아닙니다. 응답을 이미 보냈다면 그냥 빠르게 끝냅니다.
5. macOS에는 `PDEATHSIG`가 없으므로 앱이 강제 종료된 뒤 코어를 정리하는 수단은 이 EOF뿐입니다.

Rust 쪽은 정상 종료 요청 뒤 stdin을 닫고 2초를 기다린 다음 트리를 끝냅니다. 이 계약의 Python 구현은 별도 변경이며 Rust 변경만으로는 충족되지 않습니다.

### 취소와 강제 종료

1. `cancel_active`/`job.cancel`은 지금처럼 취소 파일을 씁니다.
2. 취소 요청 30초 뒤부터 `force_stop_active`가 허용됩니다. stdin을 닫고 2초 기다린 뒤에도 남아 있으면 프로세스 트리를 종료합니다.
3. 활성 slot은 종료가 확인된 뒤에만 비웁니다. 10초 안에 확인하지 못하면 slot을 그대로 두고, 분리된 정리 작업이 나중에 비웁니다.
   - **기다림 실패는 종료가 아닙니다.** 자식을 기다리는 호출이 실패하면 상태를 "unknown"으로 두고 slot을 비우지 않습니다. 감시 작업이 트리를 다시 끝내고(최대 12번 빠르게, 이후에는 5초 간격) 관찰을 계속해 종료가 실제로 확인되면 그때 비웁니다. 요청과 `force_stop_active`는 이 상태에서 `CORE_STATE_UNKNOWN`을 돌려줍니다.
   - 끝난 줄 알고 비우는 순서(`sweep`)도 종료를 확인한 뒤에만 실행합니다.
4. 강제 종료 뒤 shell이 읽기 전용 `app.bootstrap`을 실행해 중단된 작업(`jobs.recover`로 이어갈 수 있는 상태)을 화면에 돌려줍니다.

### 종료·업데이트 의도 (exit gate)

창 닫기, Alt+F4, 종료 메뉴, Cmd+Q, 세션 종료와 업데이트 설치 후 재시작이 같은 경로(`exit_gate`)를 지납니다.

- 실행 중인 작업이 없고 저장 안 한 설정도 없으면 바로 종료합니다. 아니면 `pomi-exit-confirm` 이벤트로 화면에 묻습니다. 페이로드는 `{ job, dirty, reason, intent }`이며 `reason`은 `"quit"` 또는 `"update"`입니다.
- **질문마다 `intent` ID가 있고 답은 그 ID를 실어야 합니다**(`exit_confirm(intent)`, `exit_cancel(intent)`). 열린 질문은 하나뿐입니다. 종료 질문이 열려 있을 때 종료를 또 요청하면 같은 질문(같은 ID)을 다시 알립니다. 다른 종류의 질문은 열린 질문을 **원자적으로 대체**하며, 대체된 업데이트 질문은 즉시 `UPDATE_CANCELLED`로 설치를 취소합니다. 열린 질문이 아닌 ID의 답(시간이 지난 대화상자, 대체된 대화상자)은 거부됩니다(업데이트 질문이었으면 `UPDATE_CANCELLED`, 그 밖에는 `INVALID_REQUEST`). 이런 답은 저장 안 한 설정 표시를 지우지 않고 종료로 이어지지도 않습니다. 같은 업데이트 질문이 이미 답을 기다리는 중이면 다음 설치는 `UPDATE_BUSY`입니다.
- "작업을 취소하고 종료"(`exit_confirm`) 뒤 코어에 취소를 요청하고 30초 기다립니다. 그 안에 멈추지 않으면 `pomi-exit-stuck`을 보냅니다. 화면은 "계속 기다리기"(`exit_keep_waiting`: 취소 요청을 다시 보내고 종료 대기를 다시 시작), "지금 종료"(`exit_force`), "취소"를 낼 수 있습니다.
- **업데이트 설치**는 다운로드가 끝난 뒤 같은 의도를 거칩니다. 진행 중인 작업이 있으면 `UPDATE_BUSY`로 거부합니다. 저장 안 한 설정이 있으면 `reason: "update"`로 같은 Save/Discard/Cancel 대화상자를 띄우고, `exit_confirm`(계속)이나 `exit_cancel`(취소 → `UPDATE_CANCELLED`) 응답을 기다립니다(10분 제한). 그 뒤에만 설치하고 재시작합니다.

### 정비 작업 guard (저장소 초기화·앱 초기화·업데이트 설치)

`credential_reset_storage`, `native_reset`, 업데이트의 마지막 설치·재시작 단계는 `ActiveSidecar::maintenance()`가 돌려주는 guard 하나를 변경 내내 쥐고 일합니다. guard는 새 요청을 원자적으로 막고(요청 gate를 잡고 있음) 동시에 활성 코어도, 종료를 확인하지 못해 남긴 코어 slot도, 정리를 기다리는 생성된 자식도 없음을 확인한 경우에만 만들어집니다. 요청이 실행 중이면 `BUSY`(업데이트는 `UPDATE_BUSY`), 종료가 확인되지 않은 코어나 자식이 있으면 `CORE_STATE_UNKNOWN`으로 거부합니다.

### 응답 형식·시간 제한·실패한 시작

- 요청 id가 같은 종료 응답이 유효하지 않으면 protocol 위반입니다. `response.ok`는 객체 `payload`가 있어야 하고, `response.error`는 `error.code`(`[A-Z0-9_]{1,64}`)와 문자열 `error.message`가 있어야 합니다. 위반이면 월드를 쓰는 요청은 협력 취소와 30초 유예 뒤 종료하고, 질의는 즉시 코어를 끝냅니다(`CORE_PROTOCOL`). 유예 중 코어가 취소에 유효하게 답하면 그 답이 결과입니다.
- 월드 작업이 아닌 모든 요청(`models.list`, 연결 확인 포함)은 요청을 쓴 시점부터 **요청 종류별 절대 제한**이 있습니다: `prompt.enhance`는 **630초**(저장된 공급자 시간 제한이 최대 600초이므로), 그 밖의 모든 요청은 **120초**입니다. 넘으면 코어를 끝내고 `CORE_TIMEOUT`을 돌려줍니다. 월드 작업에는 일괄 제한이 없습니다.
- 코어를 만들었지만 감독 아래 두지 못했고 종료도 확인하지 못한 자식은 핸들을 정리용 slot에 보관합니다(Windows: 중단 상태로 남아 아무것도 실행하지 않음). 이후 시작 시도마다 먼저 한정된 횟수로 다시 끝내 보고, 확인될 때까지 새 코어는 시작하지 않으며 결과는 `CORE_STATE_UNKNOWN`입니다. 앱 종료 때도 한 번 더 시도합니다.

### 응답 크기 제한

JSONL 한 줄 8 MiB, progress 한 줄 1 MiB, 요청당 stdout 밖 잡음 1 MiB, 짧은 질의의 stdout 합계 32 MiB, 요청 쓰기 20초. 넘으면 월드를 쓰는 요청은 먼저 취소하고 30초 유예를 준 뒤, 그 밖의 요청은 즉시 코어를 끝냅니다. protocol은 v1 그대로입니다. 로그 회전과 stderr ring은 유지합니다.

## 명령 시그니처 (frontend 연동용)

| 명령 | 반환 |
| --- | --- |
| `force_stop_active()` | `{ wasRunning: bool, killed: bool, bootstrap?: object, bootstrapError?: IpcError }` |
| `diagnostics_export()` | 저장 대화상자를 열고 `.txt`로 저장. 저장하면 `true`, 취소하면 `false`. 실패는 `EXPORT_FAILED` |
| `native_reset(deleteKeys)` | `{ keysDeleted, keysPartiallyDeleted, reportsCleared, errors: [코드] }`. 한 단계가 실패해도 나머지를 실행하고 결과를 돌려줍니다. 작업 중이면 `BUSY` 오류 |
| `exit_confirm(intent)` / `exit_cancel(intent)` | `pomi-exit-confirm`의 `intent`에 대한 답(계속 / 머무르기). 열린 질문이 아닌 ID는 거부 |
| `exit_keep_waiting()` | 종료 대기를 다시 시작 |
| `app_info()` | `{ version, buildSha, buildDate, os, arch }` |

### 진단 내보내기 정책

진단 번들과 "진단 복사"는 **자유 텍스트를 내보내지 않습니다.** 구성은 다음뿐입니다.

- 앱 버전, build SHA·날짜, OS·아키텍처.
- 오류 코드와 시각(출처는 식별자 문자만), 요청 종류·소요 시간·결과 코드·종료 코드·시그널(코어 실행 기록), 패닉이 난 코드 위치(모듈 상대 경로), 개수.
- 코어 stderr와 비프로토콜 stdout은 줄 전체를 가린(redact) 뒤 **분류**해서, 미리 컴파일된 목록으로만 만든 모양을 남깁니다. 입력 텍스트는 그 조각 밖으로 복사되지 않습니다.
  - Python traceback 머리줄과 예외 연쇄 문구.
  - `File "…", line N, in fn` 프레임: 파일이 코어의 자체 모듈(`mwt/*.py`, `mc_world_translator.py`, `llm_backends.py`, `webui_server.py`)일 때만 모듈 상대 경로와 줄 번호를 남기고, 함수 이름은 언제나 `[fn]`으로 바꿉니다(식별자 모양의 비밀값이나 월드 토큰이 함수 이름 자리에 올 수 있기 때문입니다). 그 밖의 프레임은 `[frame]`입니다.
  - 예외 클래스 이름: 내장 예외와 프로젝트 예외 목록에 있을 때만 남기고 아니면 `[exception]`, 메시지는 언제나 `[message omitted]`입니다.
  - 고정 문장 하나, 정확히 `[pomi] stdin closed while a request was running; cancelling`.
  - `preferences were not saved: <X>`는 `<X>`가 허용된 예외일 때만, `protocol message had values that were replaced: [...]`는 목록의 모든 항목이 `_plain()`이 만들 수 있는 플래그 이름일 때만 꼬리를 남기고 아니면 꼬리를 버립니다.
  - 그 밖의 `[pomi] ` 줄은 모두 `[pomi] [message omitted]`로 바뀝니다. 나머지 줄은 버리고 `[n lines omitted]`로 세어 보여 줍니다.
  - 허용 목록은 Python 소스와 어긋나지 않도록 Rust 테스트가 `mwt/*.py`와 예외 클래스 정의를 읽어 대조합니다.
  - Rust 쪽 `log_error`와 패닉 기록은 안정된 코드와 출처 구성요소만 남기고 오류 메시지 문자열은 쓰지 않습니다. 화면에서 온 요청 종류는 알려진 목록에 있을 때만 쓰고 아니면 `[unknown request]`입니다.
- 줄은 자르기 전에 줄 전체를 가립니다. stderr 청크 경계에서 줄이 갈리면 줄이 완성될 때까지 모아 분류하며, 종료 시 마지막 줄도 같은 규칙으로 처리합니다. 표준 출력의 비프로토콜 줄도 같은 분류를 거칩니다.
- 로컬 로그 파일과 내보내기는 같은 정책을 따릅니다. Rust 쪽 줄은 컴파일 시점 문장과 코드·숫자만 담고, 코어 줄은 위 분류를 통과한 것만 남습니다. 내보내기에는 로그 꼬리를 넣지 않습니다.

**코어 쪽 계약.** 코어가 stderr에 남기는 줄은 위 고정 문장뿐이어야 합니다. 새 진단 문구가 필요하면 shell의 허용 목록에 먼저 추가합니다. 그 밖의 `[pomi] ` 줄은 내용이 버려집니다.

강제 종료는 새 최상위 오류 코드를 만들지 않고 `detail`에 `JOB_FORCE_STOPPED`를 담습니다.

### 자격 증명 저장소 보호

- 키 디렉터리와 vault 디렉터리는 읽기·승격·격리(set aside) 전에 심볼릭 링크/junction/reparse point가 아닌지, 소유자와 ACL이 기대와 같은지 검사합니다. Windows는 `FILE_SHARE_DELETE` 없이 디렉터리 핸들을 열어 두어 검사 뒤 이름 바꾸기·교체가 불가능하게 하고(Unix는 `O_NOFOLLOW|O_DIRECTORY`로 연 핸들에서 `fstat`으로 소유자·모드를 확인하고 장치/inode를 비교), rename 직전에 한 번 더 확인합니다. 링크이면 `VAULT_PERMISSIONS`로 거부하고 링크 바깥은 건드리지 않습니다.
- **앱 데이터 폴더(root)도 검사합니다.** vault를 열기 전, 그리고 vault DB·마스터 키를 옮기거나 격리하는 rename 직전마다 root가 실제 디렉터리이고(링크·junction이 아님), Unix에서는 사용자 소유이며 그룹·다른 사용자가 쓸 수 없는지(`mode & 0o022 == 0`)를 연 핸들의 `fstat`으로 확인합니다. 사용자 소유인데 쓰기 비트가 있으면(umask 002인 배포판이 폴더를 그룹 쓰기 가능으로 만듭니다) 같은 핸들에서 `fchmod`로 그룹·다른 사용자의 쓰기 비트를 제거한 뒤 다시 확인하고, 안전하게 만들 수 없거나 소유자가 다르면 `VAULT_PERMISSIONS`로 거부합니다.
- **위협 모델: 같은 사용자(uid)로 실행되는 다른 프로세스는 보호 범위 밖입니다.** 그런 프로세스는 DB와 key 파일을 직접 읽을 수 있고 같은 권한으로 디렉터리를 바꿀 수 있습니다. 위 검사는 다른 사용자·링크 치환·잘못된 권한을 막는 것이며 악성 프로그램이나 계정 탈취를 막는다고 소개하지 않습니다.
- Custom 키에 기록된 endpoint가 없으면(예전 저장본) 키를 절대 주입하지 않고 `CREDENTIAL_ENDPOINT_UNBOUND`를 돌려줍니다. endpoint를 확인만으로 묶는 명령은 없습니다(`credentials.confirmEndpoint`는 제거됨). 화면은 사용자에게 **키를 다시 입력**하도록 안내하고, 다시 저장할 때 현재 endpoint에 묶입니다. 이미 묶인 키는 다른 endpoint로 옮길 수 없습니다(`CREDENTIAL_ENDPOINT_MISMATCH`).
- **OS 키체인 소유는 이름 공간으로 정의합니다(추론하지 않습니다).** 앱의 항목은 서비스 `PomiTranslate`(`keychain.rs`의 `SERVICE`)에 계정이 앱이 아는 provider 이름(`openai`, `gemini`, `anthropic`, `openrouter`, `comet`, `custom`) 중 하나인 것뿐이고, 이 이름 공간에는 PomiTranslate만 씁니다. 소유 기록 파일, 보관된 vault 메타데이터 대조, "알 수 없음" 표시, 확인(acknowledge) 명령은 없습니다.
  - 앱은 키체인을 나열하지 않고, 사용자가 Keychain 방식을 고르고 요청이 키를 필요로 할 때만 읽습니다(자동 읽기·가져오기 없음).
  - **삭제는 사용자의 명시적 동작에서만, 이름으로 합니다.** provider 키 삭제와 그 provider를 Keychain에서 다른 방식으로 전환할 때는 `PomiTranslate/<provider>`를, 앱 초기화(키 삭제)는 앱이 아는 모든 provider의 항목을 지웁니다. 이미 없는 항목은 삭제된 것으로 봅니다. vault가 읽히는지·무엇을 기록했는지와 무관합니다.
  - 보고하는 것은 OS 삭제 실패 하나뿐입니다. 키 삭제는 `KEYCHAIN_UNCONFIRMED`(항목을 삭제하지 못함, 그 밖에 불확실한 것은 없음)를 돌려주며 항목과 vault의 `known_keychain` 표시는 그대로 두고 앱 자신의 사본(암호화 행·세션)은 지웁니다. 저장 방식 전환은 전체가 롤백되어 `CREDENTIAL_SAVE_FAILED`입니다. `native_reset.keysDeleted`는 삭제 실패가 있을 때만 거짓이고 `errors`에 `KEYCHAIN_UNCONFIRMED`가 있으며, 다시 하면 모든 항목을 다시 삭제합니다(기록하지 않으므로 상태가 없습니다). vault·key 디렉터리·보관본은 삭제 실패와 무관하게 정리합니다.
  - 키체인 쓰기 실패 보정은 그대로입니다(`keychain_transaction.rs`): 쓰기나 메타데이터 커밋이 실패하면 이전 값을 되돌리고, 되돌리지 못하면 `CREDENTIAL_SAVE_UNCERTAIN`입니다.
  - 이전 빌드의 `keychain-ledger.json`(과 `.new`·`.broken-<ms>` 사본)은 더 이상 읽지 않습니다. 앱이 시작할 때와 앱 초기화(키 삭제) 때 **삭제**합니다(비밀이 없는 파일). `credentials.broken-*` 보관본은 저장소 초기화·앱 초기화가 정리할 뿐 내용을 읽지 않습니다.

코어 환경 변수: `POMI_APP_VERSION`, `POMI_BUILD_SHA`, `POMI_BUILD_DATE`, `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`. API 키 환경 변수는 비워서 전달합니다.

버전은 `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`에서 같아야 하며 `pnpm verify:local`이 확인합니다.

## macOS 서명 (아직 수행하지 않음)

서명·notarization은 RELEASE-01의 승인 경계이며 이 저장소 빌드는 아무것도 서명하지 않습니다. onedir 폴더에는 서명해야 하는 중첩 Mach-O가 많으므로 안쪽부터 바깥쪽 순서(inside-out)로 서명해야 합니다.

1. `pnpm sidecar:build`가 만든 `build/sidecar/nested-binaries.json`의 `files`를 위에서부터 서명합니다. 목록은 깊은 파일이 먼저이고 `pomi-sidecar` 시작 파일이 마지막입니다 (인터프리터, 확장 모듈, dylib, 시작 파일 순).
2. 각 파일은 Developer ID 인증서, hardened runtime, 보안 타임스탬프로 서명합니다 (`codesign --force --options runtime --timestamp --sign <ID>`). Python 코어에 필요한 entitlement는 최소로 두고, 필요 여부는 clean machine에서 확인합니다.
3. 그다음 바깥 `.app`을 서명합니다. resource로 들어간 `pomi-sidecar/`는 이 단계에서 다시 훑지 않도록 이미 서명된 상태여야 합니다.
4. `codesign --verify --deep --strict`와 `spctl --assess`로 중첩 파일의 서명자가 모두 같은지 확인합니다.
5. notarize 후 staple하고, 격리 속성이 붙은 clean machine에서 실행해 확인합니다.

macOS와 Linux 경로(`core_process_unix.rs`, 0755, `killpg`, `PDEATHSIG`)는 Windows 개발 머신에서 실제로 실행하지 못했습니다. 각 OS의 native gate에서 확인해야 합니다.

## 로컬 gate

GitHub Actions를 쓸 수 없으므로 `pnpm verify:local`이 CI가 보던 검사를 로컬에서 실행합니다. 단계마다 PASS/FAIL을 출력하고 하나라도 실패하면 종료 코드 1입니다.

- python: `.github/workflows/ci.yml`의 테스트 스크립트 전부 (`POMI_PYTHON`, 없으면 `python`).
- frontend: 버전 일치, `pnpm check`, `pnpm test:frontend`, `pnpm licenses:check`.
- rust: `cargo fmt --check`, `cargo clippy --lib -- -D warnings`, `cargo test --lib`.

`--only`와 `--skip`은 `python`, `frontend`, `rust` 중에서 고릅니다. Python 테스트 목록이 ci.yml과 달라지면 `scripts/verify-local.mjs`의 `PYTHON_TESTS`를 같이 고칩니다. 이 gate는 sidecar/installer 빌드나 native 검증을 대신하지 않습니다.
