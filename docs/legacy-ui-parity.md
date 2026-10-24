# Legacy Web UI와 desktop 기능 비교 — 2026-10-01

**Phase2 대체 범위 정리·개발 환경 gate 완료. Legacy UI·launcher 유지.** 현재 판정은 [현재 상태](current-state.md), 잔여 작업은 [추후 작업](follow-up-work.md), 최신 증거는 [Phase2 완료 기록](history/phase2-completion-2026-10-01.md)을 따른다. 아래 비교는 source 구현·mock·native·actual provider의 증거를 구분한다.

## 현재 비교

| Legacy 기능 | Desktop 대체와 주요 파일 | 현재 판정 |
| --- | --- | --- |
| 월드 선택/최근 경로 | WorldScreen, app.selectWorld, desktop inspection | native chooser와 합성 world workflow 검증 |
| Provider/Comet/Custom/model/모델 목록/키 | SettingsScreen, desktop_provider, provider_boundary, credentials | 관련 mock/vault native/추론 저장·재시작 PASS, OpenRouter 최소 실제1요청 PASS; 다른 provider 실제 호출/OS keychain gate 남음 |
| 언어/style/brief 개선/system prompt | SettingsScreen, desktop_prompt.py | editable prompt와 명시적 확인 후 helper; browser/Python mock PASS, 실제 유료 helper NOT RUN |
| 종류/Recommended·Story·All preset, 파일/key 규칙 | ScanScopeSettings, settings/desktop_settings | curated preset과 옵션 roundtrip/browser 회귀 PASS |
| persistent source→target replacement | SourceOverrides, desktop_settings | global exact-source override와 candidate별 manual 적용; Python/browser 회귀 PASS |
| scan/review/filter/include/exclude/manual | ReviewScreen, CandidateTable/Detail, candidates state | server paging·virtualization·keyboard·100k bounded fixture; 최신 native resume에도 새 검토 반영 PASS |
| batch/temperature/RPM/TPM/retry/file error 정책 | SettingsScreen, desktop_settings, translator | performance 및 continue-on-file-error/file write retries 구현/회귀 PASS |
| checkpoint/Resume/Cancel | 앱 관리 checkpoint, RunScreen, desktop_entry | native cancel와 최신 검토 resume PASS; legacy checkpoint enable/path는 사용자 노출하지 않음 |
| resource pack/source·target locale/skip target | ResourcePackSettings, resource-pack, desktop_entry | 월드 내부 일반 resources.zip, locale·skip 정책 구현 및 synthetic pack 회귀 PASS |
| 임의 external ZIP | ExternalResourcePacks, desktop_resource_packs, explicit backup whitelist | 구현/Python·browser/native PASS, world4+ZIP1 hash 차이0 복원 |
| folder/merge | Legacy ZIP-only와 별개의 Phase3 확장 | 미지원 |
| backup opt-out/suffix/path | 항상 자동 백업, app data 경로, BackupsScreen | 검증/recovery/legacy .pomi-backups restore 개선. 임의 경로·retention·off toggle의 동등 기능은 없음 |
| report path/event/raw JSON | Scan/Result structured summary, native JSON report export | native export 검증, 저장 위치 직접 선택. persistent report path/raw timeline은 다른 UX로 대체 |
| translate.py 상속/경로 | settings.import_legacy, desktop_legacy_import | 선택한 Python을 실행하지 않고 literal AST 읽기 전용 preview→draft→명시적 Save. native chooser/discard PASS. 동적 Python 상속은 미지원 |
| settings export/reset/import | public schema JSON, SettingsScreen/settings-import | 공개 allowlist만 export; preview/import/reset draft/save 및 validation/busy 회귀 PASS |
| locale/theme/contact/About | ko/en/ja, System/Light/Dark, AboutScreen | browser 화면/keyboard/dark 확인, contact mailto 구현. 중국어 간체 UI는 2026-10-04부터 제공(ko/en/ja/zh) |

## 남은 계약과 실제 gate

- Legacy 임의 ZIP은 Phase2 대체로 구현·검증했다. folder/merge는 Legacy 기능이 아니므로 Phase3 확장에 남긴다. app-managed backup/checkpoint 대체 차이는 아래 명시하며 100% parity 선언/Legacy 제거를 하지 않는다.
- backup/checkpoint 항상 켜짐은 안전 원칙에 맞지만, 사용자가 제어하던 경로/토글을 코드 없이 parity로 표기할 수 없다. 임의 외부 입력은 안전 preflight로 쓰기 전에 실패한다.
- report export와 literal import는 실제 구현된 대체 경로다. report path/동적 Python 실행이 그대로 존재한다고 주장하지 않는다.
- credential Local delete는 앱의 암호문/Session을 제거한다. 명시적으로 가져온 OS 원본은 자동 삭제하지 않는 계약이다. OS 저장 모드의 삭제/권한 UI는 실제 OS gate가 남아 있다.
- 실제 provider 최소 E2E·startup timeout/retry와 신규 .mcc native 복원은 [최종 검증](history/phase2-completion-2026-10-01.md)을 통과했다. 이 단일 모델 성공을 모든 provider나 전체 품질 검증으로 확대하지 않는다.

## Phase2 대체 계약 — 기존 안전 구현 유지

- Desktop은 변경 파일을 항상 자동 백업하고 앱 데이터 경로에 보관한다. 백업 끄기·접미사·임의 저장 경로 UI는 제공하지 않는다. 독립 월드 복사본을 먼저 만드는 사용자 안내를 유지한다.
- Checkpoint는 앱이 저장 위치를 관리하며 Cancel/Resume에 사용한다. legacy enable/path 옵션을 desktop에 그대로 import했다고 표시하지 않는다.
- Legacy `.pomi-backups`는 발견·무결성 확인·복원 경로를 유지한다. 기존 데이터를 자동 이동·삭제하거나 Legacy launcher를 제거하지 않는다.
- literal import의 preview는 적용 가능한 public 설정만 draft로 옮긴다. 기존 백업·checkpoint 경로를 실행 가능한 desktop 옵션으로 승격하지 않는다.
- 경로/토글 동등 기능이 필요한 사용자는 현재 Legacy/CLI를 유지한다. 임의 경로·retention·storage export는 후속 요구로 범위를 별도 결정한다.

사용자의 계속 진행 요청에 따라 기존 구현과 안전 원칙을 유지하는 기술 선택으로 범위를 정리했다. 별도 옵션 질문에 대한 사용자 답변을 받았다고 주장하지 않는다. Phase2의 문서화된 대체 범위이며 동등한 모든 Legacy 옵션을 구현했다는 의미는 아니다.

Phase2 검증→문서/review→commit→push 뒤 Phase3을 진행한다. 외부 scope가 어느 Phase에서 끝나든 안전성·백업·복원·실제 검증 없이 supported로 올리지 않는다.
