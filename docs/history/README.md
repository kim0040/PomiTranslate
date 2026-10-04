# 검증·인계 이력

날짜별 기록은 당시 checkout·도구·패키지·합성 데이터에 대한 증거다. 과거의 미커밋 상태·key 대기·테스트 수를 현재 사실로 복사하지 않는다. [현재 상태](../current-state.md)와 [추후 작업](../follow-up-work.md)이 현재 진행 판단의 기준이다.

| 기록 | 읽는 이유 |
| --- | --- |
| [2026-10-04 상용 수준 UX 개편](ux-overhaul-2026-10-04.md) | 적용 전 번역 검토·수정 재적용·실패만 재시도·비용 한도·용어집·설정 도우미·설정 탭·닫기 보호·완료 알림·창 복원·중국어 UI, 독립 검토 R1/R2 수정, 최종 gate check/frontend108/Python/Rust63/browser260 |
| [2026-10-02 문서·에셋 현지화](localization-2026-10-02.md) | 사용자 문서4언어·문자 에셋20개·UI 언어별 합성 소개 화면9장, 재생성·hash·검증 경계 |
| [2026-10-02 main 통합·잔여 대조](main-integration-2026-10-02.md) | 작업 브랜치 7개 commit 통합, 구현 완료/검증 대기 구분과 최신 backlog |
| [2026-10-02 도움말·업데이트·데이터 보존](../updates-and-data.md) | 도움말·시작 안내·앱 안 라이선스·Minecraft 고지 원문, updater(서명 키 있을 때만 설치)·외부 링크 허용 목록·데이터 위치·두 단계 초기화·설정 fsync/사본/손상 복구, 이어서 라이트/다크/시스템 화면 모드. Python23/Rust30/frontend62/browser114. 서명 release 업데이트·각 OS native 미확인 |
| [2026-10-01 네이티브 UX·Gemini·SNBT](native-ux-and-compat-2026-10-01.md) | COMP-01 SNBT, Gemini thinking/사용량, 네이티브 셸·메뉴·드래그·saves 목록, Python22/Rust28/browser94, 실제 Gemini 13요청 + 최신 모델(3.8 flash·3.5 lite·3.1 pro·latest 별칭) 배치·E2E. macOS native 미확인 |
| [2026-10-01 Phase2 완료](phase2-completion-2026-10-01.md) | 최종20 Python/58 frontend·browser 실패 수정/영향7, 신규 .mcc 생성·복원·집계와 native hash, Legacy 대체 범위 |
| [2026-10-01 실제 샘플·시작 복구·provider](sample-startup-validation-2026-10-01.md) | 샘플9435청크·복사본 restore, 최신 시작 deadline/retry와 실제 API 비용·native 복원 |
| [2026-10-01 문서·라이선스 정리](docs-refresh-2026-10-01.md) | 소개·면책·Git 제외·진행 저장과 다국어 README 보강 범위 |
| [2026-10-01 설정·추론 UI/UX](settings-ux-2026-10-01.md) | 최신 관련 검사·native·패키지 hash와 미검증 경계 |
| [2026-10-01 재개](phase2-resume-2026-10-01.md) | executor와 외부 ZIP 집계/restore, startup 조사 이력 |
| [2026-10-01 중단](phase2-pause-2026-10-01.md) | 당시 중단 시점의 잔여 위험 |
| [2026-10-01 검증](phase2-validation-2026-10-01.md) | credential/backup·브라우저와 native 증거 |
| [2026-10-01 검증 효율 조사](test-efficiency-audit-2026-10-01.md) | 반복 검사·패키징을 줄인 근거 |
| [2026-09-30 전체 인계](agent-handoff-2026-09-30.md) | 초기 Phase2/3 전체 작업 범위 |
| [2026-09-30 진행](phase2-progress-2026-09-30.md) | UI·vault·미완 gate 이력 |
| [2026-09-30 검증](phase2-validation-2026-09-30.md) | 합성 UI/core/native 검사 이력 |
| [2026-09-30 재개](phase2-resume-2026-09-30.md) | 로컬 credential 및 scope 후속 기록 |
| [초기 테스트 baseline](test-baseline.md) | 초기 형식/CLI/Web UI 기준과 한계 |

이번 문서 정리에서 원본 이력을 삭제하지 않았고 내부 링크를 새 위치로 갱신했다. 문서 이동 자체는 앱 코어·월드 처리 경로의 변경이 아니다.
