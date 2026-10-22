# 개발·빌드 안내

## 준비

제품 저장소 루트에서 실행합니다. Python 3.12, Node.js ≥22.12.0, pnpm 12.6.0과 Rust toolchain이 필요합니다. Rust는 `rust-toolchain.toml`, JavaScript는 `package.json`·`pnpm-lock.yaml`, Python은 `requirements.txt`가 기준입니다. 시스템 WebView/컴파일러 준비는 [Tauri 공식 prerequisites](https://v2.tauri.app/start/prerequisites/)를 따릅니다.

```bash
python3.12 -m venv .venv
# macOS/Linux
source .venv/bin/activate
# Windows PowerShell에서는 .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt -r requirements-build.txt
pnpm install --frozen-lockfile
```

`NBT`는 독립 codec으로 합성 fixture를 만드는 테스트 의존성입니다. 제품 NBT 처리 코어는 `mwt/nbtio.py`입니다.

## 실행

```bash
# Python sidecar를 준비한 뒤 native 개발 앱 실행
pnpm desktop:dev

# UI만 개발: 이미 준비된 sidecar를 사용할 때
pnpm desktop:dev:ui

# 웹 UI 개발 서버 (키·world backend가 연결되는 앱 설치본과 다름)
pnpm dev
```

브라우저에서 합성 데이터 화면을 볼 때는 dev 서버의 `/tests/frontend/preview.html?scenario=review`를 엽니다. 이 entry는 개발 전용이며 production build에는 포함하지 않습니다. API나 실제 월드가 연결되지 않습니다.

## 검사 선택

```bash
# 실행 없는 영향 검사 계획
pnpm verify:plan

# 필요할 때 해당 검사만 선택
.venv/bin/python test_core.py
.venv/bin/python tests/test_desktop_provider.py
pnpm test:frontend
pnpm exec playwright test tests/browser/settings-ux.spec.ts
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

전체 검사를 습관적으로 반복하지 않습니다. 구현을 안정화한 뒤 관련 검사부터 수행하고, 동일 입력의 유효 PASS는 재사용합니다. `pnpm verify:final`은 Phase 전체 완료 후보용이며 실제 provider·native·installer gate는 별도입니다. [검증 정책](verification-policy.md) · [CI 정책](ci-policy.md)

## 패키징

```bash
# 일반 incremental sidecar(onedir) + 현재 OS의 Tauri 패키지
pnpm sidecar:build
pnpm exec tauri build

# 정식 최종 후보에서만 clean sidecar + Tauri
pnpm desktop:build
```

각 OS의 sidecar를 해당 OS에서 빌드합니다. sidecar는 PyInstaller `--onedir` 폴더(`build/sidecar/dist/pomi-sidecar/`)이며 `bundle.resources`로 설치본의 resource 폴더에 들어갑니다. `src-tauri/binaries/`와 `externalBin`은 더 이상 쓰지 않습니다. 설치 결과는 기본 `src-tauri/target/` 아래에 생성되며 `CARGO_TARGET_DIR`을 지정한 환경에서는 그 경로를 따릅니다. 폴더 구조, 프로세스 감독, macOS 서명 절차는 [빌드·패키징 안내](build.md)를 따릅니다.

## 로컬 gate (GitHub Actions 없이)

```bash
pnpm verify:local                    # Python 회귀 + frontend + Rust(fmt/clippy/test)
pnpm verify:local --only rust        # 한 묶음만: python | frontend | rust
pnpm verify:local --skip python      # 일부 제외
```

Python은 `POMI_PYTHON`(없으면 `python`)으로 실행합니다. `--only`/`--skip`을 조합해 선택된 단계가 하나도 없으면 PASS로 보이지 않도록 안내 메시지와 함께 종료 코드 2로 끝납니다. 이 gate는 소스 검사이며 sidecar·installer 빌드, native, 실제 provider, release gate를 대신하지 않습니다.

Rust 테스트의 개발 모드 spawn 시험은 `PATH`에서 `python`을 찾을 수 있을 때만 실제 인터프리터를 시작하고, 없으면 건너뜁니다. 진단 내보내기 정책(자유 텍스트를 내보내지 않으며 코어 stderr는 컴파일된 허용 목록의 모양만 남김)은 [빌드·패키징 안내](build.md)를 따릅니다. Python에 모듈이나 예외 클래스를 추가하면 Rust의 허용 목록 테스트가 실패하므로 `diagnostics.rs`의 목록을 함께 고칩니다.

현재 패키지는 서명된 정식 릴리스가 아닙니다. 코드 빌드와 실제 clean-machine 설치, 서명·notarization·updater 검증을 구분합니다. 의존성 목록과 notice/source 의무를 정리하기 전 바이너리를 공개 배포하지 않습니다. [라이선스 검토](legal/license-review.md)

## 저장소 구성

| 경로 | 역할 |
| --- | --- |
| `src/`, `public/` | Svelte UI와 실행용 이미지 |
| `src-tauri/` | native shell·credential vault·Tauri 설정 |
| `mwt/` | Python core·desktop protocol·backup/provider 계층 |
| `mc_world_translator.py`, `llm_backends.py`, `env_utils.py` | 기존 CLI entry·호환 모듈 |
| `webui/`, `webui_server.py`, `run_web_ui.command` | legacy UI; parity 완료 전 유지 |
| `tests/` | 합성 fixture·core·frontend·browser 검사 |
| `packaging/`, `scripts/` | sidecar entry·빌드·검증 도구 |
| `assets/` | 저장소에서 사용하는 브랜드/아이콘 |
| `docs/` | 사용자·개발·현재 상태·후속 작업 |
| `docs/history/` | 날짜별 과거 증거와 인계 |
| `docs/legal/`, `docs/images/` | 라이선스 검토와 공개 소개용 화면 |

루트의 CLI·legacy launcher와 framework 설정은 호환 경로를 유지합니다. 문서 정리를 이유로 runtime module을 옮기지 않습니다. `dist/`, `build/`, `output/`, DB/key/report/world, `.venv/`, `node_modules/`는 Git 제외입니다. 소개용 `docs/images/`만 의도적으로 추적합니다.
