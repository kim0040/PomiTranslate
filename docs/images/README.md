# Documentation screenshots / 소개용 화면

2026-10-23 현재 Svelte 제품 UI를 Windows 10의 Playwright/Chromium으로 한국어·영어·일본어에서 캡처했고(2026-10-02 화면은 환경 설정이 "번역"·"앱" 두 부분으로 나뉘기 전, 용어집이 생기기 전의 것이었습니다), 중국어(간체) 3장은 2026-10-04 macOS의 Playwright/Chromium 캡처입니다. 모든 언어가 동일한 합성 fixture와 1440×980 viewport, light theme을 사용했습니다. 화면을 다시 그린 목업이 아닙니다. UI의 번역된 버튼·제목·입력 안내와 언어별 수동 번역 예시를 확인했습니다.

**2026-10-24 병합 주의:** `improve/commercial-readiness`에 main의 2026-10-04 UX 개편과 2026-10-11 리뷰 수정 WIP를 합쳤습니다. 한국어·영어·일본어 화면은 병합 전 commercial-readiness UI이고 중국어 화면은 병합 전 main의 UX 개편 UI입니다. 따라서 이 12장은 병합된 UI와 일치하지 않을 수 있으며, 병합된 UI가 안정되면 [localization.md](../localization.md)의 절차로 네 언어를 함께 다시 캡처하고 manifest를 갱신해야 합니다.

Captured from the current Svelte UI with synthetic data. These are browser screenshots, not evidence of native installation, actual provider usage or support for a specific model. The Korean, English and Japanese screens were captured on 2026-10-23 and the Simplified Chinese screens on 2026-10-04 (see the merge note above and the `captures` list in the manifest).

- Entry: `/tests/frontend/preview.html?scenario=review&model=deepseek/deepseek-v4.1-flash&locale={ko|en|ja|zh}&theme=light`.
- `review.png`: candidate review / 후보 검색·직접 번역 편집.
- `settings.png`: Settings, Translation tab: provider, model and custom reasoning / 환경 설정 "번역" 탭: 제공사·모델·직접 추론·저장되지 않은 변경. 모델 목록 불러오기 단추와 번역/앱 탭, 하단 저장 영역이 보입니다.
- `run.png`: pre-run confirmation, with the saved-progress notice of an interrupted job / 추론·요청 수·추정 비용·외부 전송 안내와 이어하기 안내. 번역 시작은 누르지 않았습니다.
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

All screenshots are 1440×980. Source-input hash (of the ko/en/ja capture), per-capture dates, aliases and PNG hashes are recorded in [manifest.json](manifest.json). Regeneration commands and scope are in [localization.md](../localization.md).

| File | UI locale | Bytes | SHA-256 |
| --- | --- | --- | --- |
| locales/ko/review.png | ko | 112105 | `18baecb76ef65cc2556030c943de64db8489d3dc41c45c1226228e0b7a312e70` |
| locales/ko/settings.png | ko | 122792 | `b3d288d793c43e951d72d253820ad56ae71b1af641cd8e485c32a5e359f57e63` |
| locales/ko/run.png | ko | 131685 | `5cf1db14f62952d9bb3d982ec5a2296b48b66f97b72bdf3403fd4d0e2e9d7fbe` |
| locales/en/review.png | en | 121830 | `b273805de827c767bf4e15e6a0d2cd047be8a16702cd97e8d1f5bce4b595a736` |
| locales/en/settings.png | en | 131699 | `06bbd68c5e14b90a782d2fa0c1141d79ef45a2cc5da67447957564579dd70f84` |
| locales/en/run.png | en | 142897 | `eb44165f6a694b5b162465a0533090d393726a35d46cf7ff491a2ce27119396c` |
| locales/ja/review.png | ja | 127777 | `acc80e599fa3a74e124bb2b7c68cfdc9b3fc330c06c6f608ef26b5fc84d6710a` |
| locales/ja/settings.png | ja | 143657 | `9b76cb19f85da4e4fe64fde01237ad01764f24eaca76ae230fafd063e4b67175` |
| locales/ja/run.png | ja | 152366 | `25e05ff97b4fbfdc5fe57ac4afc446e23ee3593e5e79749e3bcfca73c186dc91` |
| locales/zh/review.png | zh | 159685 | `5a9d22dbe65ff3fff35bfb9a56953272ac54d0eb06df531f5ac8e1000ee58b85` |
| locales/zh/settings.png | zh | 120691 | `14018654dd02e7e8306ce4f1f32ff1e0467cd8b26d1932e1a477589dc3c5c8a3` |
| locales/zh/run.png | zh | 146652 | `c8658d25774600f770c5f6c8416886c8a60b26eff2573bd40d0b4f7b67e149fe` |

`review.png`, `settings.png`, `run.png` at this directory's root are byte-identical aliases of `locales/ko/` for existing links. General screenshots, traces, reports, worlds, credentials and caches stay ignored under `output/`. Only these curated synthetic documentation screenshots are intentionally tracked.
