# Third-party notices / 제3자 고지

PomiTranslate의 자체 소스는 [MIT License](LICENSE)를 따릅니다. 의존성의 코드·copyright·상표와 라이선스는 각 원저작자에게 있으며 이 프로젝트의 MIT로 다시 허가되지 않습니다.

**2026-10-01 검토 상태:** source·lockfile·설치 metadata 검토는 수행했으며 알려진 프로젝트 소스의 MIT 충돌은 발견하지 못했습니다. 이 파일은 최종 installer의 전체 notice/SBOM을 대신하지 않습니다. 원문 고지 동봉과 누락 플랫폼 의존성 검토를 마칠 때까지 정식 바이너리 배포를 보류합니다. [검토 범위](docs/legal/license-review.md) · [전체 metadata 목록](docs/legal/dependency-inventory.md)

**앱 안 고지(2026-10-02):** `scripts/generate-licenses.mjs`가 데스크톱 4개 target의 Rust crate(proc-macro·build 전용 제외), 화면 JavaScript prod 의존성, 함께 번들한 글꼴(Pretendard), sidecar Python 패키지·인터프리터의 라이선스 원문을 `public/licenses/THIRD_PARTY_LICENSES.txt`로 모으고 앱 LICENSE를 `LICENSE.txt`로 복사한다. 정보 화면과 도움말 메뉴의 **오픈소스 라이선스**에서 볼 수 있고, desktop build 워크플로가 각 플랫폼에서 다시 생성한다. `pnpm licenses:check`로 최신 여부를 확인한다. 이 파일이 생겼다고 LEGAL-01의 법적 검토가 끝난 것은 아니다.

## 주요 구성

| 구성 | 기준 버전 | 원래 조건과 확인 경로 |
| --- | --- | --- |
| [Svelte](https://github.com/sveltejs/svelte) | 5.57.1 | MIT |
| [Tauri / JavaScript API](https://github.com/tauri-apps/tauri) | 2.12.0 | Apache-2.0 OR MIT |
| [Tauri plugins](https://github.com/tauri-apps/plugins-workspace) | dialog2.8.0 / shell2.4.0 / single-instance2.5.0 / updater2.13.1 / opener2.7.0 | 각 package의 Apache-2.0 OR MIT 조건 확인 |
| [ring](https://github.com/briansmith/ring/tree/0.17.14) | 0.17.14 | Apache-2.0 AND ISC; 포함된 코드별 notice 유지 |
| [rusqlite](https://github.com/rusqlite/rusqlite) / SQLite | 0.40.2 / libsqlite3-sys0.38.2 | wrapper MIT, SQLite [public domain 안내](https://www.sqlite.org/copyright.html) |
| [keyring-rs](https://github.com/open-source-cooperative/keyring-rs) | 4.2.0 | MIT OR Apache-2.0 |
| [zeroize](https://github.com/RustCrypto/utils) | 1.9.0 | Apache-2.0 OR MIT |
| [Pretendard Variable](https://github.com/orioncactus/pretendard) | 1.3.9 | SIL OFL 1.1, Copyright (c) 2021 Kil Hyung-jin. UI 글꼴로 `public/fonts/PretendardVariable.woff2`를 앱에 번들하며 원문은 `public/fonts/Pretendard-OFL.txt`와 앱 안 오픈소스 라이선스 목록에 포함 |
| [Python](https://docs.python.org/3.12/license.html) | 3.12 | PSF와 포함된 코드별 조건·acknowledgements |
| [python-lz4](https://github.com/python-lz4/python-lz4) | 4.4.5 | BSD-3-Clause; 포함된 native LZ4 조건도 유지 |
| [Python keyring](https://github.com/jaraco/keyring) | 25.6.0 | MIT; transitive/backend는 별도 확인 |
| [NBT](https://github.com/twoolie/NBT) | 1.5.1 | MIT, fixture 생성용 테스트 의존성 |
| [PyInstaller](https://pyinstaller.org/en/v6.16.0/license.html) | 6.16.0 | GPL + bundling 예외, 일부 파일 Apache-2.0 |

Vite·TypeScript·Vitest·Playwright 등 개발 도구도 각 라이선스를 따릅니다. `axe-core`, `@axe-core/playwright`, `lightningcss`와 Rust의 cssparser 계열 등 **MPL-2.0** 구성은 파일 단위 조건과 소스 안내를 유지해야 합니다. Unicode 데이터/라이브러리의 **Unicode-3.0** 고지도 보존합니다. 모든 의존성이 MIT라고 표시하지 않습니다.

## MPL 구성의 소스 안내

현재 로컬 metadata에서 MPL-2.0으로 확인한 버전입니다. 실제 최종 배포물에 포함되는지와 변경 여부는 release 시 확인합니다. 아래 source는 upstream이며 MPL 조건으로 제공됩니다.

- [cssparser0.37.0](https://crates.io/api/v1/crates/cssparser/0.37.0/download)
- [cssparser-macros0.7.1](https://crates.io/api/v1/crates/cssparser-macros/0.7.1/download)
- [dtoa-short0.3.5](https://crates.io/api/v1/crates/dtoa-short/0.3.5/download)
- [option-ext0.2.0](https://crates.io/api/v1/crates/option-ext/0.2.0/download)
- [selectors0.38.0](https://crates.io/api/v1/crates/selectors/0.38.0/download)
- [axe-core4.13.0](https://www.npmjs.com/package/axe-core/v/4.13.0), [@axe-core/playwright4.13.0](https://www.npmjs.com/package/@axe-core/playwright/v/4.13.0)
- [lightningcss1.33.0](https://www.npmjs.com/package/lightningcss/v/1.33.0), [darwin-arm641.33.0](https://www.npmjs.com/package/lightningcss-darwin-arm64/v/1.33.0)

각 source는 해당 upstream 라이선스를 따릅니다. 프로젝트 MIT는 MPL 부분을 대체하지 않습니다.

## 적용 범위

이 저장소에는 설치된 dependencies, Python interpreter, 빌드된 sidecar, 사용자 월드 또는 Minecraft 게임 파일을 포함하지 않습니다. 의존성을 포함하는 installer를 재배포할 때는 해당 버전의 LICENSE/COPYING/NOTICE와 필요한 소스 안내를 함께 제공해야 합니다. 플랫폼 system library와 WebView runtime도 최종 package 기준으로 확인합니다.

## 번들 글꼴

화면의 기본 글꼴은 Pretendard Variable 1.3.9(SIL Open Font License 1.1, Copyright (c) 2021 Kil Hyung-jin, [orioncactus/pretendard](https://github.com/orioncactus/pretendard))이며 `public/fonts/PretendardVariable.woff2`로 앱에 포함됩니다. 라이선스 원문은 같은 폴더의 `Pretendard-OFL.txt`이고 앱의 **오픈소스 라이선스**에도 같은 원문이 들어 있습니다. OFL은 글꼴을 소프트웨어와 함께 번들·재배포하는 것을 허락하되 글꼴 자체를 단독으로 판매하지 않고 원문과 저작권 고지를 함께 제공하도록 요구합니다. `src/components/Brand.svelte`의 로고 글자(PomiTranslate 워드마크와 마크의 "P")는 Pretendard 글리프의 윤곽선(outline)에서 만든 벡터 경로이며, 이는 OFL이 허용하는 파생이고 Pretendard 이름이나 글꼴 파일로 배포하지 않습니다.

브랜드 이미지·Pomi·화면 예시의 구성은 [에셋 안내](assets/README.md)와 [화면 출처](docs/images/README.md)를 따릅니다. 시스템 글꼴 이름 참조는 글꼴 파일의 재배포 허가가 아닙니다. Minecraft·맵·리소스팩에 대한 권리는 [면책·권리 안내](docs/disclaimer.md)를 따릅니다.
