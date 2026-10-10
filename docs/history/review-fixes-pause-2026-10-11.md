# 코드 리뷰 수정 WIP 중단·인계 — 2026-10-11

> **판정:** 리뷰에서 나온 수정은 로컬 WIP 브랜치 3개에 있다. **main에는 통합하지 않았다.** 이 커밋은 문서 인계만 담고 있으며, 제품 동작과 Phase 상태(Phase2 개발 환경 gate 완료 / Phase3 진행 중 / release-ready 아님)는 바뀌지 않았다.

## 무엇을 했나

사용자 요청으로 `6e46710`을 기준으로 전체 코드를 평가하고 개선을 제안했다. 이어서 제안 전부를 구현해 달라는 요청을 받아 작업자 3개가 각자 별도 worktree에서 병렬로 구현했다.

구현 도중 사용자가 "하던 것까지만 하고 마무리, 나중에 이어서"를 요청했다. 그래서 각 작업자는 진행 중이던 편집까지만 마치고 WIP로 커밋했다. 중단 요청 뒤에는 새 테스트, 빌드, 리뷰, 통합을 시작하지 않았다.

- 유료 API 호출: $0
- native 앱 실행: 없음
- 실제 sample world 쓰기: 없음

### 기준선 검증 (`6e46710`, 2026-10-11 이번 세션에서 실행)

| 검사 | 결과 |
| --- | --- |
| `pnpm check` | 0 errors / 0 warnings |
| `pnpm test:frontend` | 17 files / 108 PASS |
| Python (`test_core.py` + `tests/test_*.py` 26 suites, 각각 별도 프로세스) | 모두 PASS |
| `cargo test` (src-tauri) | 63 PASS |

브라우저(Playwright), native, 실제 provider는 실행하지 않았다. 이 PASS는 `6e46710` 소스에만 해당하며 WIP 브랜치의 증거가 아니다.

### 환경 정리

`$TMPDIR`에 PomiTranslate sidecar(PyInstaller onefile)가 남긴 `_MEI*` 폴더 419개(8.1 GB)가 있었다. 418개를 지웠다.
- 지운 기준: `lz4/`, `keyring-25.6.0.dist-info/`, `base_library.zip`이 모두 있고, 열린 파일이 없고, 하루 이상 지난 폴더
- 최근 폴더 1개는 남겼다.

## 리뷰 결과 요약 (ID: REVIEW-2026-10-11)

점수 (10점 만점):

| 영역 | 점수 |
| --- | --- |
| 계획 대비 기능 | 8 |
| 코어 정확성·안전 | 6.5 |
| 보안 | 7.5 |
| UX 흐름 | 7.5 |
| 시각 디자인 | 8 |
| 접근성 | 7.5 |
| 코드 품질 | 6.5–7 |

아래 표는 지적 사항과 각 WIP 브랜치에서의 처리 상태다.

| # | 심각도 | 지적 | 처리 브랜치 | 상태 |
| --- | --- | --- | --- | --- |
| R1 | 높음 | sidecar onefile을 응답 직후 SIGKILL → `_MEI` 누수, 오류 경로에서 안쪽 Python이 고아로 남아 계속 쓸 수 있음 | native-security | 구현 (native 미확인) |
| R2 | 높음 | 1.20.3–1.21.4 JSON 문자열 컴포넌트(`'"text"'`)를 평문으로 처리 → 따옴표가 빠지면 이름·줄 소실 | core-safety | 구현, 테스트 미실행 |
| R3 | 높음 | Windows stdio가 UTF-8이 아님 / `master.new`를 연 채 rename | native-security | 구현 (Windows 미확인) |
| R4 | 높음 | Linux에서 `flock`이 Java `fcntl` 잠금과 충돌하지 않아 게임 실행 중인지 감지 못함 | core-safety | 구현, 테스트 미실행 |
| R5 | 높음 | 레거시 webui CSRF/Origin/Host 검사 없음 → 저장 키 유출 경로 | native-security | 구현 + 테스트 PASS |
| R6 | 중간 | 백업·manifest fsync 누락 | core-safety | 구현, 테스트 미실행 |
| R7 | 중간 | CLI 복원에 잠금이 없음, recovery 세트가 `latest`가 되어 두 번 복원하면 되돌아감 | core-safety | 구현, 테스트 미실행 |
| R8 | 중간 | 쓰기 단계에서 월드 전체 재해시, reapply manifest 처리가 O(n²) | core-safety | 구현, 회귀 테스트 미작성 |
| R9 | 중간 | 가격을 모르면 비용 한도가 조용히 꺼짐 | core-safety + ui-ux | 양쪽 구현, 통합 미확인 |
| R10 | 중간 | 장애가 아닌 실패에서 재시도가 증폭됨(배치당 최대 약 138회) | core-safety | 구현, 테스트 미작성 |
| R11 | 중간 | Keychain 잔존, 동기 command가 main thread를 막음, write에 deadline 없음, custom key가 origin에 묶이지 않음 | native-security | 구현 + Rust 테스트 PASS |
| R12 | 중간 | CI에 Python 3개 suite가 빠져 있고, Rust를 어느 OS에서도 실행하지 않음, action이 SHA로 고정되지 않음 | native-security | 구현 (`rust.yml` 신규) |
| R13 | 낮음 | `--no-backup`이 resources.zip에만 적용됨, 표준이 아닌 리전 이름을 (0,0)으로 처리, 다른 provider env 키로 대체, CSP 보강, `reveal_world_folder`가 `.app`을 실행 | core-safety / native-security | 구현 |
| U1 | 높음 | 비용 한도 기본값 0(무제한), Run 요약이 토큰 위주 | ui-ux | 구현, 브라우저 미확인 |
| U2 | 높음 | 오류 배너가 스크롤 영역 안에 있음, 저장 오류가 위쪽에만 표시됨, 실패를 조용히 삼키는 catch | ui-ux | 구현, 브라우저 미확인 |
| U3 | 중간 | `translate()`가 모르는 동적 키에서 TypeError, 죽은 `backend.ts`, 제공사 라벨 중복 | ui-ux | 구현 + unit PASS |
| U4 | 중간 | 단계 이름·용어, 설정 번역 탭 과밀, 첫 실행 클릭 약 20번, 후보 표 위치 열 잘림 | ui-ux | 구현, 브라우저 spec 깨짐 예상 |
| U5 | 중간 | `AppState` 1573줄 / `SettingsScreen` 1092줄 | ui-ux | 분리 완료 (unit PASS 시점 기준) |
| U6 | 낮음 | aria-live가 진행률마다 읽힘, 글자 크기 옵션 없음 | ui-ux | 구현, axe 미확인 |

## WIP 브랜치 (로컬 전용, 원격 push 안 됨)

원격으로 브랜치를 push하는 명령은 이번 세션의 권한 분류기에 거부됐다. 세 브랜치는 **이 Mac의 로컬 저장소에만** 있다. 다음 세션에서 사용자 승인을 받아 push하거나, main에 통합한 뒤 지운다.

Worktree는 `.claude/worktrees/agent-*`에 남아 있다(`.git/info/exclude`로 무시됨). 그 안에는 gitignored 상태로 `node_modules` symlink, 복사한 `dist/`, `src-tauri/binaries/`가 있다.

| 브랜치 | SHA (기준 `6e46710`) | worktree | 규모 |
| --- | --- | --- | --- |
| `wip/2026-10-11-core-safety` | `5b4150d` | `.claude/worktrees/agent-a17d35c469067fc00` | 9 files, +1946/−258 |
| `wip/2026-10-11-native-security` | `f3ebeee` | `.claude/worktrees/agent-a26432d9d60bdfbc6` | 22 files, +2278/−292 |
| `wip/2026-10-11-ui-ux` | `99b7efd` | `.claude/worktrees/agent-aefda9fe92653106a` | 82 files, +4034/−2778 |

### core-safety (`5b4150d`) — 테스트를 전혀 실행하지 않음

변경 파일: `mc_world_translator.py`, `mwt/{extract,locking,region,safety,desktop_entry}.py`, 새 테스트 3개(`tests/test_text_components.py`, `tests/test_locking.py`, `tests/test_backup_restore_safety.py`). 마지막 작은 편집 2개 전까지는 `py_compile`이 통과했다.

**R2 — JSON 문자열 컴포넌트**
- `EXTRACTOR_VERSION` 4, `TEXT_COMPONENT_NBT_DATA_VERSION` 4298(25w02a)을 둔다.
- DataVersion이 4298 미만이거나 없을 때, `"..."` 문자열은 새 ref kind `json_string_tag`로 처리한다. 안쪽 텍스트만 번역하고 `json.dumps(..., ensure_ascii=False)`로 다시 쓴다.
- `match_wrapping_quotes`는 provider 응답에만 적용하고 사용자 수정에는 적용하지 않는다.

**R4 — 잠금**
- session 잠금 감지는 `fcntl.lockf`로 하고, Linux에서만 `flock`도 함께 본다. (device, inode) registry로 같은 파일의 fd를 중복으로 열고 닫는 것을 막는다.
- `WorldWriteLock`은 OS 잠금을 계속 유지하고, stale 잠금은 OS 잠금을 잡은 상태에서만 takeover한다.
- macOS는 `lockf`만 쓴다. 실제 기기에서 확인해야 한다.

**R6 — 내구성:** `fsync_path`, `fsync_directory`를 `add_many`, `_write_manifest`, `publish_latest`, `restore`, atomic write, resources.zip 교체에 적용했다.

**R7 — 복원**
- recovery 세트를 `latest`로 게시하지 않는다. `default_restore_backup_id`는 검증된 recovery가 아닌 세트 중 최신을 고른다.
- CLI `restore_backup_cli`가 두 잠금을 잡고, `--backup-set-id`를 받는다. 데스크톱 `--restore`는 `_restore_backup`을 거친다.

**R8 — 성능**
- reapply는 `add_many`를 한 번만 부르고, 없는 `.mcc`만 기록한다. `record_new_external_chunks`는 한 번만 검증하고 한 번만 쓴다.
- `verify()`는 새 항목만 검사한다.
- 월드 해시는 1회 읽기(`world_fingerprint_and_digests`)와 파일별 digest로 바꿨다. 덮어쓰기 전에 파일별로 비교한다(`PlanInvalidated`).
- 쓰기 사이에 저장하는 checkpoint는 `world_fingerprint: ""`와 `world_files_fingerprint`를 쓴다.

**R9 — 비용 한도 계약 (데스크톱 `translate.start` / `translate.resume` / `translate.retry_failed`)**
- **거부:** `max_cost_usd > 0`이고, `budgetDisabled`가 아니고, catalog나 저장된 단가가 없고, provider가 OpenRouter가 아니면 provider 호출 전에 거부한다. 응답 형식:
  `{"type":"response.error","error":{"code":"cost_cap_unpriced","recoverable":true,"details":{"maxCostUsd","provider","model","ackField":"unpricedCapAck"}}}`
- **동의:** 요청 payload의 `"unpricedCapAck": true`. JSON boolean이 아니면 `INVALID_REQUEST`.
- **결과:** 한도가 적용된 실행이면 `response.ok`에 `"costCapEnforced": true|false`가 들어간다. 한도가 없으면 키가 없다.
- **예외:** apply, reapply, manual-only, dry run은 거부하지 않는다.
- **CLI:** `--allow-unpriced-cost-cap`이 없으면 `SystemExit`.
- **주의:** 코드 이름이 소문자 `cost_cap_unpriced`다. 기존 코드는 UPPER_SNAKE다. 통합할 때 이름 규칙을 정하고 UI와 맞춘다.

**R10 — 재시도:** 원래 배치당 `max_batch_retries + len(texts)` 요청까지만 보낸다. 하위 배치는 최대 2회 시도한다. `invalid_response`와 `content_filter`는 circuit breaker에 반영한다.

**R13:** `--no-backup`은 경고만 내고 무시한다(`backup_always_on` 경고). 표준이 아닌 리전 이름은 쓰지 않고 `nonstandard_region_name`으로 건너뛴다.

**남은 일**
- 전체 Python suite 실행
- `tests/test_review_apply.py`의 budget 테스트 2개 수정. 단가 없는 provider "openai"를 쓰므로 이제 `cost_cap_unpriced`가 난다. `provider="openrouter"`로 바꾸거나 `unpricedCapAck: true`를 보낸다.
- R8 bounded-time 회귀 테스트, 쓰기 사이 checkpoint에서 resume하는 테스트
- R10 요청 수를 세는 mock 테스트

**위험**
- `_check_unchanged`가 쓰기 단계에서 월드를 바꾸는 기존 테스트를 `PlanInvalidated`로 깰 수 있다.
- `verify()`가 디스크 manifest를 채택한다.
- 데스크톱 `--translate` 분기는 `RequestRefused`를 잡지 않아 traceback이 난다.
- 쓰기 도중 crash가 나면 checkpoint의 `world_fingerprint`가 비고, 데스크톱 resume이 거부된다. CLI resume만 받아 준다.

### native-security (`f3ebeee`) — 작업자가 테스트 PASS를 보고함 (coordinator 재실행 안 함)

보고된 결과: `cargo test` 84 PASS. 새 Python 테스트(`test_sidecar_process` 5, `test_provider_key_fallback` 6, `test_webui_security`)와 관련 기존 suite 15개 PASS.

**R1 — sidecar 수명주기 (`src-tauri/src/sidecar_process.rs` 신규)**
- 요청은 state lock 밖에서 30초 deadline으로 쓰고 stdin을 닫는다. sidecar가 스스로 종료하면 `_MEI`가 정리된다.
- 정상 경로: 최대 15초 기다린 뒤 SIGTERM, 5초 뒤 kill.
- 이상 경로: cancel 파일을 쓰고 3초 → SIGTERM → 10초 → kill.
- cancel 파일은 프로세스마다 따로 만들고, 프로세스가 끝난 것을 확인한 뒤에만 지운다.
- `TMPDIR`를 `app_cache_dir/sidecar-tmp`로 바꾸고, 시작할 때 1시간 넘은 `_MEI*`를 지운다.
- Python 쪽: parent-death watchdog(`--parent-pid`, Windows는 handle 대기), SIGTERM은 협조적 취소로 처리, `emit()`이 broken pipe를 견딘다.
- onefile은 유지했다. 요청마다 bundle을 다시 풀기 때문에 cold 요청에 약 8.5초가 든다. onedir 전환은 별도 과제다.

**R3**
- `_utf8_stdio()`와 PyInstaller `--python-option 'X utf8'`을 적용했다.
- `master.new`는 handle을 닫은 뒤 rename하고 디렉터리를 fsync한다. 남은 `master.new`는 키도 row도 없을 때만 지우고 다시 만든다.

**R11**
- 앱이 직접 쓴 keychain 항목(`known_keychain=1`)은 모드를 바꾸거나 삭제할 때 지운다. 가져온 원본은 지우지 않는다.
- Keychain 모드의 `read()`는 앱이 쓴 항목만 쓴다.
- `credential_status`, `credential_import`, `cancel_active`를 async + `spawn_blocking`으로 바꿨다.
- 요청 크기 상한은 16 MiB다.
- custom key를 origin에 묶는다(`credential_origins` 테이블). origin이 기록되지 않은 기존 custom key는 다시 입력해야 한다. `http://`는 loopback에만 허용한다.

**R13**
- `reveal_item_in_dir(world/level.dat)`를 쓴다.
- JSONL 모드에서는 keyring을 절대 쓰지 않는다.
- CSP에 `base-uri`, `form-action`, `object-src`, `frame-ancestors`를 추가했다.
- `credential-key/`에 Time Machine 제외 xattr를 단다.
- 다른 provider env 키로 대체하지 않는다.

**R5 — webui:** 실행마다 만드는 token, Host/Origin/`Sec-Fetch-Site` 검사, JSON content-type만 허용, `report_path`와 `checkpoint_path`를 월드나 앱 데이터 안으로 제한.

**R12**
- `ci.yml`에 glossary, review_apply, model_suitability와 새 테스트 3개를 추가했다.
- `rust.yml`을 새로 만들었다(main push/PR, `src-tauri/**`, macOS·Windows). macOS·Windows runner 비용이 CI 정책과 맞는지 사용자 확인이 필요하다.
- action을 SHA로 고정하고 top-level `permissions: contents: read`를 추가했다.

**새 오류 코드 (UI 문구가 아직 없음)**
- `REQUEST_TOO_LARGE`
- `CUSTOM_KEY_ORIGIN_MISMATCH`
- `CUSTOM_ENDPOINT_INSECURE`

**후속**
- `mc_world_translator.py:485`에서 `resolve_api_key`에 `base_url=`을 넘긴다(core-safety와 통합한 뒤).
- sidecar를 다시 빌드한다. 복사한 binary는 예전 Python이다.

**미확인**
- native에서: staged stop, `_MEI` 리다이렉트와 정리, CSP, reveal, Time Machine 제외
- Windows에서: watchdog, rename, bootloader 종료 시 자식 Python 처리

### ui-ux (`99b7efd`) — 마지막 편집 이후 검사를 다시 돌리지 않음

마지막 실행 결과(최종 편집 전): `svelte-check` 0/0(373 files), vitest 19 files / 135 PASS. 함께 실행한 `tests/test_user_data_durability.py`도 PASS다.

Playwright는 `settings-tabs`와 `settings-ux`만 돌렸고 12개가 실패했다. 고급 섹션과 Run 화면의 Details를 접었기 때문이다. 이 실패는 아직 고치지 않았다.

**완료**
- U3: `translate()` fallback과 `labelFor()`, catalog parity·placeholder 테스트(en/zh `{name}` 불일치 수정), `backend.ts` 삭제, `describeError()`, `providerLabel()` 단일화. 새 설치의 기본 provider는 메모리에서만 openrouter로 맞춘다.
- U5: `src/lib/app/*` 모듈로 분리(같은 facade 유지), `SettingsScreen`을 탭 4개와 `settings-draft.svelte.ts`로 분리.
- U2: 오류 배너는 최대 3개를 쌓고 중복을 합치며 스크롤 밖에 둔다. 저장 오류는 저장 바 안에 인라인으로 보여 준다. 오류·동작 버튼 토스트는 자동으로 닫히지 않는다. 조용히 실패하던 곳에 info 토스트를 띄운다.
- U1 / R9 UI
  - 설정 도우미에 비용 한도 칸을 넣었다($5 기본, "제한 없음" 선택 가능).
  - Run 화면에 "시작 전" 요약 줄을 두고, Details는 접었다.
  - 한도가 없으면 안내하고 $5로 바로 설정할 수 있게 했다.
  - `UnpricedNotice`가 start/resume/retry에서 `unpricedCapAck`을 보낸다. reapply에서는 보내지 않는다(core 예외와 일치).
  - Result 화면에 `costCapEnforced === false` 안내를 보여 준다.
- U6: aria-live는 단계만 알린다. 글자 크기 100/115/130%는 `--font-scale`로 적용하고 `mwt/userdata.py`의 `font_scale`에 저장한다.
- U4
  - 단계 이름을 4개 언어로 바꿨다. ko: 월드 고르기 / 번역할 문장 찾기 / 번역할 문장 고르기 / 번역 준비 / 결과 확인·적용. 첫 검토는 "선택"으로 표시한다.
  - ko에서 제공사→AI 서비스, 후보→번역할 문장으로 바꿨다.
  - 영문 고지는 그대로 두고 옆에 현지어 문장을 추가했다.
  - 설정 번역 탭은 제공사, 모델, 키, 언어, 비용 한도만 남기고 나머지는 "고급"으로 접었다(`openSettingsFor`).
  - 투어는 자동으로 시작하지 않는다. 설정 도우미는 `size="fit"`을 쓴다.
  - 후보 표의 위치 열은 폭이 1000px보다 클 때만 보이고, 필터는 접었다.

**남은 일**
- browser spec 갱신: `settings-tabs`, `settings-ux`, `workflow`, `setup-wizard`, `help-and-maintenance`, `manual-translations`, `review-apply`, `locale-zh`, `ux-flow`. 새 ko 이름은 스크립트로 일괄 치환만 했고 실행하지 않았다.
- unpriced 흐름 browser spec 작성
- ja/zh 용어, 영어 전체 문구 점검
- 115/130% 글자 크기, 다크 모드, 320px, axe 확인
- `docs/images/manifest.json`의 `src/lib/backend.ts` 항목 정리
- 바뀐 UI로 소개 screenshot 다시 캡처

**위험:** "약 n분"은 요청당 10초를 가정한다.

## 다음 에이전트가 할 순서

1. **브랜치 보존 확인:** `git branch -v | grep wip/`. 원격 push는 사용자 승인을 받은 뒤에 한다.
2. **core-safety 마무리**
   - `test_review_apply` budget 테스트를 고치고, R8·R10 테스트를 쓴다.
   - 데스크톱 `--translate`가 `RequestRefused`를 처리하게 한다.
   - 전체 Python suite를 실행한다.
3. **통합 브랜치에서 native-security와 merge**
   - `mwt/desktop_entry.py`에서 충돌이 예상된다. 두 작업자가 서로 다른 구역을 고쳤다.
   - `mc_world_translator.py:485`에 `base_url=`을 넘긴다.
   - 오류 코드 이름 규칙을 정한다(`cost_cap_unpriced`와 UPPER_SNAKE).
   - `cargo test`와 Python 전체를 돌린다.
4. **ui-ux merge**
   - 새 오류 코드 3개의 4개 언어 문구를 추가한다.
   - browser spec을 고친다.
   - `pnpm check`, frontend, 영향받은 browser spec을 돌린다. 마지막에 `pnpm verify:final`을 한 번 돌린다.
5. **독립 리뷰:** core·native diff는 high-risk(데이터 손실·보안)이므로 Opus 외 모델 1개 + Fable로 검토한다. UI diff는 Opus로 검토한다. 리뷰어에게는 이 문서의 요구와 diff만 준다.
6. **sidecar 다시 빌드 → macOS native 확인**
   - `_MEI` 없음, 취소·오류 경로에서 고아 Python 없음
   - CSP, reveal, Time Machine xattr
   - 비용 한도 거부와 동의
   - 설정 도우미 흐름
   - Windows는 CI `rust.yml`과 이후 PLATFORM-01에서 확인한다.
7. **문서 갱신**
   - `docs/privacy*.md` 4개 언어: keychain 정리 / 가져온 항목만 사용 / Time Machine 제외 / custom key origin / JSONL keyring 없음
   - `docs/user-guide*`: custom `http://`는 localhost만 허용, URL을 바꾸면 키 다시 입력, 비용 한도 기본값 / 단가 미확인 동의, 새 단계 이름
   - CLI 문서: `--backup-set-id`, `--allow-unpriced-cost-cap`, `--no-backup` 무시, env 키 대체 제거
   - webui 문서: 서버를 다시 시작하면 새로고침, 경로 제한
   - `support-matrix.md`: 1.20.3–1.21.4 JSON 문자열 컴포넌트
   - screenshot과 manifest
8. 통합 커밋을 main에 push한 뒤 WIP 브랜치와 worktree를 정리한다(`git worktree remove`).

이번 중단 범위 밖의 기존 backlog(UX-NATIVE-01 → PROVIDER-01 → COMP-02~04 → QUALITY-01/TM)는 [추후 작업](../follow-up-work.md) 순서를 따른다. 위 통합이 그보다 먼저다.
