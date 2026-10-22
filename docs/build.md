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
| Windows | 자식마다 Job Object(`KILL_ON_JOB_CLOSE`). `CREATE_SUSPENDED`로 만들고 `AssignProcessToJobObject` 후 `ResumeThread`하므로 job 밖에서 코드가 돌지 않습니다. 모든 API 결과를 검사하고 실패하면 자식을 끝낸 뒤 오류를 냅니다(fail closed). job 핸들은 상속되지 않고, 상속되는 핸들은 파이프 3개로 제한합니다. 앱이 죽으면 마지막 핸들이 닫혀 트리 전체가 끝납니다. |
| Linux | 새 프로세스 그룹. 강제 종료는 `killpg(SIGKILL)`. `PR_SET_PDEATHSIG`를 걸고 부모가 이미 바뀌었는지 다시 확인합니다. |
| macOS | 프로세스 그룹 + `killpg`. `PDEATHSIG`가 없으므로 앱이 사라지면 stdin EOF에 의존합니다. |

**stdin EOF 정책(가정).** Python 코어는 "stdin이 닫히면 작업을 취소하고 몇 초(약 10초) 안에 종료"한다고 가정합니다. Rust의 강제 종료는 이 동작에 의존하지 않습니다. 이 가정이 실제로 지켜지는지는 코어 쪽 변경과 함께 확인해야 합니다.

### 취소와 강제 종료

1. `cancel_active`/`job.cancel`은 지금처럼 취소 파일을 씁니다.
2. 취소 요청 30초 뒤부터 `force_stop_active`가 허용됩니다. stdin을 닫고 2초 기다린 뒤에도 남아 있으면 프로세스 트리를 종료합니다.
3. 활성 slot은 종료가 확인된 뒤에만 비웁니다. 10초 안에 확인하지 못하면 slot을 그대로 두고, 분리된 정리 작업이 나중에 비웁니다.
4. 강제 종료 뒤 shell이 읽기 전용 `app.bootstrap`을 실행해 중단된 작업(`jobs.recover`로 이어갈 수 있는 상태)을 화면에 돌려줍니다.

### 응답 크기 제한

JSONL 한 줄 8 MiB, progress 한 줄 1 MiB, 요청당 stdout 밖 잡음 1 MiB, 짧은 질의의 stdout 합계 32 MiB, 요청 쓰기 20초. 넘으면 월드를 쓰는 요청은 먼저 취소하고 30초 유예를 준 뒤, 그 밖의 요청은 즉시 코어를 끝냅니다. protocol은 v1 그대로입니다. 로그 회전과 stderr ring은 유지합니다.

## 명령 시그니처 (frontend 연동용)

| 명령 | 반환 |
| --- | --- |
| `force_stop_active()` | `{ wasRunning: bool, killed: bool, bootstrap?: object, bootstrapError?: IpcError }` |
| `diagnostics_export()` | 저장 대화상자를 열고 `.txt`로 저장. 저장하면 `true`, 취소하면 `false`. 실패는 `EXPORT_FAILED` |
| `app_info()` | `{ version, buildSha, buildDate, os, arch }` |

진단 번들에는 앱 버전, build SHA·날짜, OS, 마지막 200줄의 가려진 stderr, 로그 꼬리, 오류 코드와 시각만 들어갑니다. 키와 월드 텍스트는 넣지 않습니다. 강제 종료는 새 최상위 오류 코드를 만들지 않고 `detail`에 `JOB_FORCE_STOPPED`를 담습니다.

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
