# 업데이트·데이터 보존·초기화 — 2026-10-02

이 문서는 앱 안 업데이트가 어떻게 동작하는지, 업데이트·청소 도구·초기화가 사용자 데이터에 무엇을 하는지 정리한다. 배포 담당자가 해야 할 남은 단계도 함께 적는다.

## 앱 안 업데이트

| 구성 | 위치 | 상태 |
| --- | --- | --- |
| Tauri 공식 updater (`tauri-plugin-updater` 2.13.1) | `src-tauri/src/updates.rs`, `tauri.conf.json` `plugins.updater` | 연결됨. 확인 주소 `https://github.com/kim0040/PomiTranslate/releases/latest/download/latest.json` |
| 서명 검증 공개키 | `tauri.conf.json` `plugins.updater.pubkey` | **비어 있음.** 키가 없으면 새 버전 알림과 다운로드 페이지 열기만 하고, 앱 안 설치는 하지 않는다 |
| 서명된 업데이트 파일 | `.github/workflows/desktop-build.yml` | secret `TAURI_SIGNING_PRIVATE_KEY`가 있을 때만 `createUpdaterArtifacts`로 생성 |
| `latest.json` 게시 | GitHub Release | **미구현(RELEASE-01).** 공개 release는 승인 경계 안에서 사람이 진행. 설치 경로의 구현 완료와 실제 signed update 검증 대기를 구분한다 |

동작:

- 환경 설정 > 업데이트, 메뉴 "업데이트 확인…"(macOS 앱 메뉴, 그 외 도움말 메뉴), 하루 한 번 자동 확인(시작 4초 뒤, 끌 수 있음). 자동 확인은 새 버전이 있을 때만 알림·사이드바 배지를 띄우고 실패는 조용히 넘긴다.
- 요청은 GitHub의 `latest.json` 하나다. 월드, 키, 사용 기록, 설치 ID를 보내지 않는다.
- 설치는 서명 검증 → 설치 → 재시작 순서다. 스캔·번역·복원과 같은 실행 잠금을 쓰므로 작업 중에는 시작되지 않고, 설치 중에는 작업이 시작되지 않으며, 종료도 보류된다.
- 서명이 맞지 않으면 설치하지 않는다(`UPDATE_SIGNATURE_INVALID`). 아직 `latest.json`이 없으면 "업데이트 정보가 게시되지 않음"으로 안내한다.
- 버전은 `package.json`·`Cargo.toml`·`tauri.conf.json`이 같아야 하며 `tests/frontend/version.test.ts`가 확인한다.

### 배포 담당자가 켜는 방법

1. `pnpm tauri signer generate -w ~/.tauri/pomitranslate.key` 로 키 쌍을 만든다. 개인키와 암호는 저장소·채팅·로그에 남기지 않는다.
2. 공개키 문자열을 `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 넣고 commit한다(공개 정보).
3. GitHub secret `TAURI_SIGNING_PRIVATE_KEY`(필요하면 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)를 등록한다.
4. Desktop build 워크플로가 만든 `.app.tar.gz`/`-setup.exe`/`.AppImage`와 각 `.sig`를 release에 올리고, 그 서명과 URL로 `latest.json`(`version`, `notes`, `pub_date`, `platforms.{darwin-aarch64,darwin-x86_64,windows-x86_64,linux-x86_64}.{signature,url}`)을 같은 release에 올린다.
5. 이전 버전 설치본에서 새 버전 설치 → 재시작 → 설정·키·백업 유지, 그리고 작업 중 설치 거부를 각 OS에서 확인한다. 이 확인 전에는 업데이트 기능을 "검증됨"으로 표시하지 않는다.

macOS 코드서명·공증과 Windows 코드서명은 updater 서명과 별개다(RELEASE-01).

## 데이터가 저장되는 곳

| 내용 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 설정·최근 월드·이어서 할 작업·스캔 결과·모델 목록·**월드 백업** | `~/Library/Application Support/PomiTranslate` | `%APPDATA%\PomiTranslate` | `$XDG_DATA_HOME/PomiTranslate` (`~/.local/share/...`) |
| 암호화된 API 키(DB + 설치별 키 파일)·실행 보고서 | `~/Library/Application Support/app.pomitranslate.desktop` | `%APPDATA%\app.pomitranslate.desktop` | `~/.local/share/app.pomitranslate.desktop` |

환경 설정 > 데이터 보관 위치에서 두 경로를 보고 폴더를 열 수 있다.

### 쓰기 복구 기록(journal)의 위치와 보관

번역·복원은 백업 세트 폴더(`…/backups/<월드>/<세트 id>/`) 안에 `journal.json`을 둔다. 쓰는 동안만 `staging/`(새 파일 임시 보관)이 생기고, 복구가 충돌을 만나면 `quarantine/`이 생긴다. 기록은 **그 백업 세트와 함께만** 사라진다. 아직 정리되지 않은(중단된) 작업의 세트는 어떤 정리로도 지우지 않는다. 정리되지 않은 상태에는 `partial`·`recovery_conflict`도 포함되며, 그 월드의 새 번역·복원·다른 작업의 복구를 모두 막는다. 월드마다 세대 카운터 `world-state.<월드 키>.json`이 저장소 폴더에 하나 있고, 백업 세트를 지워도 남는다. 백업은 월드 쓰기에서 항상 켜져 있다(`backup=false`는 무시되고 경고 `backup_always_on`이 붙는다). 외부 ZIP 잠금 파일은 `<앱 데이터>/locks/`에 있고 내용이 없다. 이전 버전의 백업(기록 없음)은 그대로 목록에 나오고 복원할 수 있지만 `legacy`로 표시된다. 자세한 내용은 [쓰기 안전 모델](safety-model.md).

## 업데이트·청소 도구로 지워지지 않는가

- **업데이트**: updater와 설치 프로그램은 앱 번들(`.app`, `Program Files`/설치 폴더, AppImage)만 바꾼다. 위 두 폴더는 건드리지 않는다. 설정 파일은 알 수 없는 키를 보존하고 schema를 함께 기록한다.
- **청소 도구**: macOS 정리 앱, Windows 디스크 정리·저장소 센스, Linux tmp 정리는 캐시(`~/Library/Caches`, `%TEMP%`, `%LOCALAPPDATA%\...\Cache`, `/tmp`)를 대상으로 한다. 앱 데이터는 Application Support / Roaming AppData / XDG data에 있어 일반 청소 대상이 아니다. 단, "삭제된 앱의 잔여 파일" 정리 기능은 앱을 지운 뒤에 이 폴더를 지울 수 있다.
- **WebView 저장소**: 이전 버전은 테마와 첫 실행 안내 동의를 WebView 저장소(macOS `~/Library/WebKit`, Windows `%LOCALAPPDATA%\...\EBWebView`)에만 두었다. 이 저장소는 청소 도구가 지울 수 있다. 이제 이 값은 설정 파일의 `app_prefs`에 저장하고, WebView 저장소는 시작 화면 깜빡임을 줄이는 빠른 사본으로만 쓴다. 처음 실행할 때 기존 값을 한 번 옮긴다.
- **파일 손상**: 설정은 임시 파일에 쓰고 디스크까지 동기화(`fsync`)한 뒤 교체한다. 같은 내용의 `settings.backup.json`을 먼저 쓰므로 본 파일이 손상되거나 지워져도 사본에서 읽는다. 손상된 파일은 덮어쓰지 않고 `settings.damaged-<hash>.json`으로 남긴다. 모델 목록은 fsync·atomic replace로 쓰지만 사본·손상 복구는 설정 파일에만 구현됐다. 모델 목록이 손상되면 빈 catalog로 처리하고 다시 조회한다.
- **일시 파일**: 번역 코어(PyInstaller onefile)는 실행할 때마다 OS 임시 폴더에 풀렸다가 종료 시 지워진다. 데이터는 그곳에 두지 않는다.

## 초기화

환경 설정 > 초기화. 두 번 묻는다.

1. 첫 대화상자: 삭제 항목(모든 설정·화면 설정, 최근 월드, 이어서 할 작업·스캔 결과, 모델 목록)과 유지 항목(월드 백업, 원본 월드), "저장된 API 키도 모두 삭제"(기본 선택, OS 키체인에 저장한 키 포함).
2. 두 번째 대화상자: "되돌릴 수 없습니다" 경고와 최종 확인. 키 삭제를 선택했다면 그 사실을 다시 적는다.

초기화 후 앱이 다시 시작되고 첫 실행 안내가 나온다. 코어는 `confirm: "reset"` 없는 요청을 거부하고, 데이터 폴더 밖이나 링크 대상은 따라가지 않는다(링크 자체만 지운다). 스캔·번역·복원 중에는 버튼이 꺼지고 실행 잠금도 거부한다. **월드 백업은 지우지 않는다.** 백업까지 지우려면 데이터 폴더를 직접 지워야 하며, 도움말의 "앱을 완전히 지우려면"에 적었다.

## 앱 제거 (Windows)

설치 폴더(기본 `%LOCALAPPDATA%\PomiTranslate`)와 바로가기·제거 정보는 항상 지운다. "애플리케이션 데이터 삭제하기"(기본 해제)를 고르면 추가로:

- `%APPDATA%\app.pomitranslate.desktop`(암호화된 키 DB·설치별 키 파일·실행 보고서)과 `%LOCALAPPDATA%\app.pomitranslate.desktop`(로그·WebView 저장소)을 지운다(Tauri 기본 동작).
- `%APPDATA%\PomiTranslate`에서 초기화와 같은 항목(설정과 그 사본, 모델 목록, 스캔 결과, 이어서 할 작업, 검토 초안)을 지운다(`src-tauri/windows/hooks.nsh`, 목록은 `mwt/userdata.py`의 `RESET_FILES`/`RESET_DIRS`와 테스트로 맞춘다). 링크는 따라가지 않고 링크만 지운다.
- **월드 백업**, 월드별 세대 카운터, 손상된 설정 사본, 잠금 파일은 남긴다. 제거 프로그램은 OS 키체인에 접근하지 않으므로 키체인에 저장한 키는 앱 안의 키 삭제나 초기화(키 삭제)로 지운다.

업데이트(`/UPDATE`)는 이 상자와 관계없이 아무 데이터도 지우지 않는다.

## 검증 (2026-10-02, Linux)

- Python `tests/test_user_data_durability.py`: 손상·삭제된 설정 복구와 손상본 보존, `app_prefs` 검증·유지, 확인 없는 초기화 거부, 초기화 후 백업·링크 대상 유지.
- Rust: 외부 링크 허용 목록 테스트, 요청 허용 목록에 `prefs.set`/`app.reset` 추가. `cargo test` 29 PASS.
- Browser `tests/browser/help-and-maintenance.spec.ts` 10개: 첫 실행→시작 안내, 기존 설치의 값 이전, 도움말 메뉴, 외부 링크, 서명/무서명/오프라인 업데이트, 자동 확인, 데이터 위치, 초기화 두 단계(키 유지/삭제).
- **미확인**: 실제 서명된 release로의 업데이트 설치와 재시작(키·release 필요), 각 OS 실제 창에서의 메뉴·폴더 열기·외부 링크, Windows/Linux 청소 도구 실측.
