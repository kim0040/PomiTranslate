# Documentation screenshots / 소개용 화면

2026-10-24 병합된 Svelte 제품 UI(`improve/commercial-readiness`에 main의 UX 개편과 리뷰 수정 WIP를 합친 소스)를 Windows 10의 Playwright/Chromium으로 한국어·영어·일본어·중국어(간체) 네 언어에서 한 번에 캡처했습니다. 모든 언어가 동일한 합성 fixture와 1440×980 viewport, light theme을 사용했습니다. 화면을 다시 그린 목업이 아닙니다. UI의 번역된 버튼·제목·입력 안내와 언어별 수동 번역 예시를 확인했습니다.

Captured from the merged Svelte UI with synthetic data, all four languages in one run on 2026-10-24 (Windows 10, Playwright Chromium). These are browser screenshots, not evidence of native installation, actual provider usage or support for a specific model. Earlier captures (Korean/English/Japanese from 2026-10-23 and Simplified Chinese from 2026-10-04) came from the two pre-merge UIs and were replaced; the manifest's `captures` list now records one date, environment and source hash for all twelve.

- Entry: `/tests/frontend/preview.html?scenario=review&model=deepseek/deepseek-v4.1-flash&locale={ko|en|ja|zh}&theme=light`.
- `review.png`: step 3, choose text to translate, with one row selected and its custom translation visible / 3단계 "번역할 문장 고르기": 한 문장을 고르고 직접 번역을 입력한 모습.
- `settings.png`: Settings, Translation tab, "Advanced translation options" open with Custom reasoning (max) selected and the unsaved-changes bar / 환경 설정 "번역" 탭의 "고급 번역 옵션": 추론 방식 "직접 설정"·최대 강도와 저장하지 않은 변경 표시줄.
- `run.png`: step 4, prepare translation (not started), with the interrupted-work notice, the $5 cost limit, estimate and safety backup / 4단계 "번역 준비": 이어하기 안내, 비용 한도 US$5, 예상 비용, 안전 백업. 번역 시작은 누르지 않았습니다.
- Source world names, paths, models, prices and saved-key badges are synthetic. No real keys or private worlds were read. Foreign source strings and technical IDs remain original.
- Capture waited for fonts, page transitions and save notifications. External requests 0, paid requests 0, scan/translation/restore jobs 0; viewport overflow 0. Three earlier Korean URLs are refreshed aliases of this capture.

## Language gallery / 언어별 화면

| UI language | Review / 검토 | Settings / 설정 | Run / 실행 |
| --- | --- | --- | --- |
| 한국어 | [화면](locales/ko/review.png) | [화면](locales/ko/settings.png) | [화면](locales/ko/run.png) |
| English | [Screen](locales/en/review.png) | [Screen](locales/en/settings.png) | [Screen](locales/en/run.png) |
| 日本語 | [画面](locales/ja/review.png) | [画面](locales/ja/settings.png) | [画面](locales/ja/run.png) |
| 简体中文 | [界面](locales/zh/review.png) | [界面](locales/zh/settings.png) | [界面](locales/zh/run.png) |

## Capture manifest / 파일 정보

All screenshots are 1440×980. Source-input hash, the capture date and environment (`captures`), aliases and PNG hashes are recorded in [manifest.json](manifest.json). Regeneration commands and scope are in [localization.md](../localization.md).

| File | UI locale | Bytes | SHA-256 |
| --- | --- | --- | --- |
| locales/ko/review.png | ko | 120939 | `27fbb8e532ada9ed3fce3402e7d51971e55d632bf475a2b52a9d547b29e14566` |
| locales/ko/settings.png | ko | 103858 | `e7045f18e1ce497c9da10d665781318ff07c7a01b17df68b71423af4e33c0802` |
| locales/ko/run.png | ko | 148726 | `c01bd24affe5e9990e3398720a6dfa30aa6acc565e7b2982ef57a59c19afb20a` |
| locales/en/review.png | en | 133808 | `976d9628838e433c03be5cc3037d887170bfe788cfc60620aa8743cc18edce2c` |
| locales/en/settings.png | en | 113239 | `ab84f5ba892a808a77b491f21840851be61e21ad9b59a6c0c415d6480cfda34d` |
| locales/en/run.png | en | 172104 | `89b1301ee88e16235393b7c2529d9a8c9a4a09a0e946712eaf659584a0e399fb` |
| locales/ja/review.png | ja | 141211 | `85607fe1dc6d92b905e1c3e919c8c39861a5cd6211dfde15ef4ee3539d95c576` |
| locales/ja/settings.png | ja | 118772 | `990eb18a8e2ef2d0759bf14c63e2ec7784d91eeffc21a5f45029e278964397dd` |
| locales/ja/run.png | ja | 178856 | `747636f11ae754c0ff1189470581e54f185b8e3db404b3bd299092c57b729fc2` |
| locales/zh/review.png | zh | 108284 | `65009605c47ec002105b7b1d355f443d29c9d6d85aa90d9c884b2d0025cd8836` |
| locales/zh/settings.png | zh | 87331 | `688923e25c64a9157eac3affbe5f12c7e93118e8a028544ec6b924074a40eb1f` |
| locales/zh/run.png | zh | 122224 | `2ecedc03078a05b1a9110232afb14d6759b5c09cf3089284d5ecb0b825eeacef` |

`review.png`, `settings.png`, `run.png` at this directory's root are byte-identical aliases of `locales/ko/` for existing links. General screenshots, traces, reports, worlds, credentials and caches stay ignored under `output/`. Only these curated synthetic documentation screenshots are intentionally tracked.
