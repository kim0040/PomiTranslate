# 라이선스·과금 검토 — 2026-10-01

## 판정

**프로젝트 소스의 기존 MIT 유지. 정식 바이너리 배포의 라이선스 완료 판정은 보류.**

LICENSE는 이번 작업 전부터 MIT였다. 원저작자 식별자 `gimhyeonmin`을 보존하면서 사용자 요청의 김현민 이름을 함께 표시했다. 표준 MIT 허락·보증 부인·책임 제한 본문은 변경하지 않았다. 검토한 source·직접 의존성과 로컬 metadata 범위에서 소스 MIT 유지의 명백한 충돌은 발견하지 못했다. 이는 모든 플랫폼·모든 배포물에 대한 법률적 적합성 확인이 아니다.

이 저장소 push는 자체 source·문서·합성 UI 이미지의 공개 갱신이다. dependency source·빌드 앱·world·credential·원본 맵은 포함하지 않는다. 따라서 미완 installer의 전체 고지를 완료했다고 선언하지 않는다.

## 확인 범위

- root LICENSE, requirements.txt, package.json/pnpm-lock.yaml, src-tauri/Cargo.toml/Cargo.lock, sidecar script 및 브랜드 이미지 경로.
- Cargo 외부525 package 중 로컬 metadata333 확인·192 미확인. JavaScript 설치72와 Python 설치14 metadata를 수집했다. 세부 버전·누락은 [목록](dependency-inventory.md)에 기록했다.
- 검토한 native crate metadata에는 MIT/Apache/BSD/ISC/Zlib/Unlicense 외에 MPL-2.0과 Unicode-3.0도 있다. MIT로 일괄 재허가하지 않는다.
- 자동 취약점 검사·최종 SBOM·각 OS package의 포함 파일 분석·전체 notice 동봉 확인은 이번에 수행하지 않았다.

## 별도 조건

### PyInstaller

PyInstaller6.16.0의 공식 [license 설명](https://pyinstaller.org/en/v6.16.0/license.html)을 확인했다. 생성된 bundle에 대해 프로젝트 라이선스를 선택할 수 있는 예외가 있지만, 함께 포함된 dependency 조건을 지켜야 한다. PyInstaller 자체를 수정해 배포하는 경우는 그 도구의 조건을 따르며 이 프로젝트의 MIT로 덮어쓰지 않는다. hooks-contrib의 파일별 license/예외도 final sidecar에 포함된 hook 기준으로 확인한다.

### MPL·Unicode·복수 라이선스

[Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)에 근거해 MPL 부분의 고지·소스 제공 의무와 프로젝트의 별도 파일을 구분했다. 프로젝트 자체 파일을 모두 MPL로 바꿔야 한다는 결론은 아니다. 원문 LICENSE와 정확한 source 안내는 최종 배포물에 포함해야 한다. `AND` 조건, ring의 포함 코드별 notice, Unicode 고지와 Python standard-library acknowledgements도 확인해야 한다.

### Python·SQLite·OS 구성

Python을 sidecar에 넣으면 [Python3.12 license](https://docs.python.org/3.12/license.html)와 포함된 코드별 고지를 확인한다. SQLite 원본의 [public-domain 안내](https://www.sqlite.org/copyright.html)가 wrapper 전체의 MIT 조건을 없애는 것은 아니다. Windows/Linux source cache가 없는 package, OS credential backend, GTK/WebKit/WebView 등은 해당 OS의 실제 bundle·system dependency 기준으로 검토한다.

### 번들 글꼴

화면 글꼴로 [Pretendard Variable](https://github.com/orioncactus/pretendard) 1.3.9(`public/fonts/PretendardVariable.woff2`)를 번들한다. 라이선스는 SIL Open Font License 1.1(Copyright (c) 2021 Kil Hyung-jin, Reserved Font Name "Pretendard")이며 원문은 `public/fonts/Pretendard-OFL.txt`다. OFL의 번들 조건(글꼴 단독 판매 금지, 각 사본에 저작권 고지와 라이선스 동봉, 파생 글꼴이 예약 이름을 쓰지 않을 것)에 따라 원문을 앱의 `public/licenses/THIRD_PARTY_LICENSES.txt`(앱 안 **오픈소스 라이선스** 화면)와 [제3자 고지](../../THIRD_PARTY_NOTICES.md)에 포함한다. 브랜드 로고 글자(`src/components/Brand.svelte`)는 Pretendard 글리프 윤곽선에서 만든 벡터 경로이며, 글꼴 파일이나 이름을 배포하지 않으므로 OFL이 허용하는 파생으로 본다. 이 판단은 법률 자문이 아니며 정식 배포 전 최종 확인 대상이다.

### API·모델·비용

앱 자체의 결제·구독은 없다. 외부 API의 호출·추론·재시도·credit 구매 등은 제공사 약관과 요금에 따르며 무료 앱의 MIT와 별개다. 모델의 이용·출력 조건도 확인해야 한다. [OpenRouter Terms](https://openrouter.ai/terms)와 [Pricing](https://openrouter.ai/pricing)을 확인했으며 특정 모델의 영구 무료 이용이나 재배포 권리를 보장하지 않는다. 사용자가 선택하는 다른 제공사·Custom 서비스는 그 해당 약관을 확인해야 한다. 이번 문서/화면 작업에서 유료 호출은 하지 않았다.

### Minecraft·맵·브랜드

[Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines)와 [EULA](https://www.minecraft.net/en-us/eula)의 현재 문서를 확인했다. Minecraft는 기능 설명용 부제이며 비공식 고지, 제작자와 이메일을 명시했다. 무료 개인 프로젝트를 공개한다는 이유만으로 이름·자산 조건이 면제된다고 설명하지 않는다. MIT는 제3자의 게임·맵·리소스팩·상표 권리를 부여하지 않는다.

## 정식 배포 전 완료 조건

1. target별 dependency/SBOM과 실제 sidecar/native library 포함 목록을 확정한다.
2. 미확인192개 및 모든 OS의 optional/backend/system 구성 license를 확인한다. GPL/LGPL 등 별도 조건이 발견되면 link·source/재링크·고지 의무를 개별 검토한다.
3. 정확한 버전의 LICENSE/COPYING/NOTICE·copyright를 package에 넣고 MPL source 안내·수정본 소스 제공을 확인한다.
4. Python interpreter 및 포함된 OpenSSL/zlib/LZ4 등 실제 포함 구성의 고지를 확인한다.
5. Pomi/이미지의 생성·편집 출처, 글꼴 사용·상표/제3자 자산 문제를 최종 확인한다. 번들 글꼴 Pretendard Variable 1.3.9의 binary와 OFL 원문은 `public/fonts/`에 있고([아래](#번들-글꼴)) 그 외 제3자 글꼴 binary는 repository에 없다. AI 생성 이미지의 독점적 권리가 보장된다고 주장하지 않는다.
6. 고지 파일이 실제 installer에 포함되는지 검사한 후에만 해당 artifact의 license gate를 완료한다. 해결되지 않은 충돌이 있으면 해당 배포를 보류한다.

추적: [추후 작업 LEGAL-01](../follow-up-work.md). 면책 안내는 [별도 문서](../disclaimer.md)이며 법적으로 배제할 수 없는 책임까지 없앤다고 주장하지 않는다.
