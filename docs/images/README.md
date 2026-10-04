# Documentation screenshots / 소개용 화면

2026-10-04 현재 Svelte 제품 UI를 macOS의 Playwright/Chromium으로 한국어·영어·일본어·중국어(간체)에서 새로 캡처했습니다. 네 언어 모두 동일한 합성 fixture와 1440×980 viewport, light theme을 사용했습니다. 화면을 다시 그린 목업이 아닙니다. UI의 번역된 버튼·제목·입력 안내와 언어별 수동 번역 예시를 확인했습니다.

Captured from the current Svelte UI with synthetic data. These are browser screenshots, not evidence of native installation, actual provider usage or support for a specific model. Since 2026-10-04 the Simplified Chinese UI is captured too.

- Entry: `/tests/frontend/preview.html?scenario=review&model=deepseek/deepseek-v4.1-flash&locale={ko|en|ja|zh}&theme=light`.
- `review.png`: candidate review / 후보 검색·직접 번역 편집.
- `settings.png`: provider, model and custom reasoning / 제공사·모델·직접 추론·저장되지 않은 변경.
- `run.png`: pre-run confirmation / 추론·요청 수·추정 비용·외부 전송 안내. 번역 시작은 누르지 않았습니다.
- Source world names, paths, models, prices and saved-key badges are synthetic. No real keys or private worlds were read. Foreign source strings and technical IDs remain original.
- Capture waited for fonts, page transitions and save notifications. External requests0, paid requests0, scan/translation/restore jobs0; viewport overflow0. Three earlier Korean URLs are refreshed aliases of this capture.

## Language gallery / 언어별 화면

| UI language | Review / 검토 | Settings / 설정 | Run / 실행 |
| --- | --- | --- | --- |
| 한국어 | [화면](locales/ko/review.png) | [화면](locales/ko/settings.png) | [화면](locales/ko/run.png) |
| English | [Screen](locales/en/review.png) | [Screen](locales/en/settings.png) | [Screen](locales/en/run.png) |
| 日本語 | [画面](locales/ja/review.png) | [画面](locales/ja/settings.png) | [画面](locales/ja/run.png) |
| 简体中文 | [界面](locales/zh/review.png) | [界面](locales/zh/settings.png) | [界面](locales/zh/run.png) |

## Capture manifest / 파일 정보

All screenshots are 1440×980. Source-input hash, aliases and PNG hashes are recorded in [manifest.json](manifest.json). Regeneration commands and scope are in [localization.md](../localization.md).

| File | UI locale | Bytes | SHA-256 |
| --- | --- | --- | --- |
| locales/ko/review.png | ko | 155169 | `32dd671f69115a066d8a0de373fabf4f4f3daa0f729caa8a1ad89e8bc73f09ba` |
| locales/ko/settings.png | ko | 116065 | `e318612b9b6bbbfeab0ba9a8be5e378e28f0027f65a3c9232f40a85fa931cdef` |
| locales/ko/run.png | ko | 138001 | `447df1d326d1e5b625c7c246076a2f4b1c50161af26b9d265a2f5075eaa0027a` |
| locales/en/review.png | en | 163128 | `663e9d052026520ebb3e4a18f83e0d20b3e2c489534e6f71e2ffc39d0c0f6485` |
| locales/en/settings.png | en | 119658 | `2b62f0f5ac264f43ecb5974fd522a8126b7f7ae1f67079414579c14c82f7bda5` |
| locales/en/run.png | en | 142787 | `20f6ea839da3c6cc9ea9c69858bf7490a4deb2351861de0f2e0af66a3e887c39` |
| locales/ja/review.png | ja | 177875 | `3360e18ae46efb859e52f2273f6e9041695853d4b691ed8c40ac8d717f582d08` |
| locales/ja/settings.png | ja | 131994 | `fdcc318a08818e1653fd5aead23bafd50a20bf689a4e34205dbba6a82d1ccc41` |
| locales/ja/run.png | ja | 161204 | `2189daf3b200995c2202afe23662192bc8bd3c7bac49bbaa83e12f34e2f0ccd0` |
| locales/zh/review.png | zh | 159685 | `5a9d22dbe65ff3fff35bfb9a56953272ac54d0eb06df531f5ac8e1000ee58b85` |
| locales/zh/settings.png | zh | 120691 | `14018654dd02e7e8306ce4f1f32ff1e0467cd8b26d1932e1a477589dc3c5c8a3` |
| locales/zh/run.png | zh | 146652 | `c8658d25774600f770c5f6c8416886c8a60b26eff2573bd40d0b4f7b67e149fe` |

`review.png`, `settings.png`, `run.png` at this directory's root are byte-identical aliases of `locales/ko/` for existing links. General screenshots, traces, reports, worlds, credentials and caches stay ignored under `output/`. Only these curated synthetic documentation screenshots are intentionally tracked.
