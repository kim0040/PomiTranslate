# 의존성 라이선스 목록 — 2026-10-01

이 문서는 현재 lockfile와 로컬 설치 metadata를 읽은 **검토용 목록**입니다. 최종 배포물에 실제 포함되는 코드·native library의 SBOM, 고지 원문 모음, 모든 OS의 라이선스 준수 완료 증거는 아닙니다. local path·API key·world 데이터는 포함하지 않습니다.

## 기준과 누락

- `src-tauri/Cargo.lock` SHA-256: `8c33b54824c2965b1d781f336ebe11109d2aaef87ec59162ed88c175fbc0b340`
- `pnpm-lock.yaml` SHA-256: `1842315dfedaed598fb2e1ca1fef2c6df1c9c1b33d97fa50e90398fbf80ff716`
- `requirements.txt` SHA-256: `ecc0fe0c93a6ff349a5607b3d19a86a97c2b75227757ace80c0706f48e92fd03`

- Cargo lock의 외부 package 525개 중 333개 metadata 확인, 192개 `UNVERIFIED`(로컬 source cache 없음).
- JavaScript 설치 metadata 72개 확인. 이 목록은 모든 OS의 optional npm package가 설치됐음을 뜻하지 않습니다.
- Python 설치 metadata 14개 확인. 도구·test 의존성도 포함하며 모두 앱에 포함된다는 뜻은 아닙니다.
- 번들 글꼴 1개(Pretendard Variable 1.3.9, SIL OFL 1.1)는 package metadata가 아니라 `public/fonts/`의 파일과 그 라이선스 원문에서 확인했습니다. 아래 [번들 글꼴](#번들-글꼴) 표를 참고하세요.
- `OR`는 대체 선택, `AND`는 복수 조건입니다. `/`와 파일별 예외는 원문을 확인합니다. metadata가 라이선스 원문·copyright·NOTICE를 대신하지 않습니다.
- [제3자 고지](../../THIRD_PARTY_NOTICES.md) · [검토 판정과 배포 보류](license-review.md)

## Rust / Cargo

| Package | Version | License metadata | Source |
| --- | --- | --- | --- |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/adler2/2.0.1/download) |
| aes | 0.9.3 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/aes/0.9.3/download) |
| aho-corasick | 1.1.5 | Unlicense OR MIT | [version source](https://crates.io/api/v1/crates/aho-corasick/1.1.5/download) |
| alloc-no-stdlib | 3.0.0 | BSD-3-Clause | [version source](https://crates.io/api/v1/crates/alloc-no-stdlib/3.0.0/download) |
| alloc-stdlib | 0.3.0 | BSD-3-Clause | [version source](https://crates.io/api/v1/crates/alloc-stdlib/0.3.0/download) |
| android_system_properties | 0.1.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/android_system_properties/0.1.6/download) |
| anyhow | 1.0.104 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/anyhow/1.0.104/download) |
| apple-native-keyring-store | 1.0.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/apple-native-keyring-store/1.0.2/download) |
| async-broadcast | 0.7.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/async-broadcast/0.7.2/download) |
| async-channel | 2.5.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/async-channel/2.5.0/download) |
| async-executor | 1.14.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/async-executor/1.14.0/download) |
| async-io | 2.6.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/async-io/2.6.0/download) |
| async-lock | 3.4.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/async-lock/3.4.2/download) |
| async-process | 2.5.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/async-process/2.5.0/download) |
| async-recursion | 1.1.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/async-recursion/1.1.1/download) |
| async-signal | 0.2.14 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/async-signal/0.2.14/download) |
| async-task | 4.7.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/async-task/4.7.1/download) |
| async-trait | 0.1.92 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/async-trait/0.1.92/download) |
| atk | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/atk/0.18.2/download) |
| atk-sys | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/atk-sys/0.18.2/download) |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/atomic-waker/1.1.2/download) |
| autocfg | 1.5.1 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/autocfg/1.5.1/download) |
| base64 | 0.21.7 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/base64/0.21.7/download) |
| base64 | 0.22.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/base64/0.22.1/download) |
| base64 | 0.23.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/base64/0.23.1/download) |
| bit-set | 0.8.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/bit-set/0.8.0/download) |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/bit-vec/0.8.0/download) |
| bitflags | 1.3.2 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/bitflags/1.3.2/download) |
| bitflags | 2.13.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/bitflags/2.13.2/download) |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/block-buffer/0.10.4/download) |
| block-buffer | 0.12.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/block-buffer/0.12.1/download) |
| block-padding | 0.4.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/block-padding/0.4.2/download) |
| block2 | 0.6.2 | MIT | [version source](https://crates.io/api/v1/crates/block2/0.6.2/download) |
| blocking | 1.7.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/blocking/1.7.0/download) |
| brotli | 9.0.0 | BSD-3-Clause AND MIT | [version source](https://crates.io/api/v1/crates/brotli/9.0.0/download) |
| brotli-decompressor | 6.0.1 | BSD-3-Clause/MIT | [version source](https://crates.io/api/v1/crates/brotli-decompressor/6.0.1/download) |
| bs58 | 0.5.1 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/bs58/0.5.1/download) |
| bumpalo | 3.20.3 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/bumpalo/3.20.3/download) |
| bytemuck | 1.25.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/bytemuck/1.25.2/download) |
| byteorder | 1.5.0 | Unlicense OR MIT | [version source](https://crates.io/api/v1/crates/byteorder/1.5.0/download) |
| bytes | 1.12.1 | MIT | [version source](https://crates.io/api/v1/crates/bytes/1.12.1/download) |
| cairo-rs | 0.18.5 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/cairo-rs/0.18.5/download) |
| cairo-sys-rs | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/cairo-sys-rs/0.18.2/download) |
| camino | 1.2.6 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/camino/1.2.6/download) |
| cargo-platform | 0.1.9 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/cargo-platform/0.1.9/download) |
| cargo_metadata | 0.19.2 | MIT | [version source](https://crates.io/api/v1/crates/cargo_metadata/0.19.2/download) |
| cargo_toml | 1.0.1 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/cargo_toml/1.0.1/download) |
| cbc | 0.2.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/cbc/0.2.1/download) |
| cc | 1.5.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/cc/1.5.1/download) |
| cesu8 | 1.1.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/cesu8/1.1.0/download) |
| cfb | 0.14.0 | MIT | [version source](https://crates.io/api/v1/crates/cfb/0.14.0/download) |
| cfg-expr | 0.15.8 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/cfg-expr/0.15.8/download) |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/cfg-if/1.0.5/download) |
| chrono | 0.4.45 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/chrono/0.4.45/download) |
| cipher | 0.5.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/cipher/0.5.2/download) |
| cmov | 0.5.4 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/cmov/0.5.4/download) |
| combine | 4.6.8 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/combine/4.6.8/download) |
| concurrent-queue | 2.5.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/concurrent-queue/2.5.0/download) |
| const-oid | 0.10.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/const-oid/0.10.2/download) |
| cookie | 0.18.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/cookie/0.18.2/download) |
| core-foundation | 0.10.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/core-foundation/0.10.1/download) |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/core-foundation-sys/0.8.7/download) |
| core-graphics | 0.25.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/core-graphics/0.25.0/download) |
| core-graphics-types | 0.2.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/core-graphics-types/0.2.0/download) |
| core_detect | 1.0.0 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/core_detect/1.0.0/download) |
| cpubits | 0.1.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/cpubits/0.1.1/download) |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/cpufeatures/0.2.17/download) |
| cpufeatures | 0.3.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/cpufeatures/0.3.1/download) |
| crc32fast | 1.5.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/crc32fast/1.5.2/download) |
| crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/crossbeam-channel/0.5.17/download) |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/crossbeam-utils/0.8.23/download) |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/crypto-common/0.1.7/download) |
| crypto-common | 0.2.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/crypto-common/0.2.2/download) |
| cssparser | 0.37.0 | MPL-2.0 | [version source](https://crates.io/api/v1/crates/cssparser/0.37.0/download) |
| cssparser-macros | 0.7.1 | MPL-2.0 | [version source](https://crates.io/api/v1/crates/cssparser-macros/0.7.1/download) |
| ctor | 1.0.13 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/ctor/1.0.13/download) |
| ctutils | 0.4.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/ctutils/0.4.2/download) |
| darling | 0.24.1 | MIT | [version source](https://crates.io/api/v1/crates/darling/0.24.1/download) |
| darling_core | 0.24.1 | MIT | [version source](https://crates.io/api/v1/crates/darling_core/0.24.1/download) |
| darling_macro | 0.24.1 | MIT | [version source](https://crates.io/api/v1/crates/darling_macro/0.24.1/download) |
| dbus | 0.9.12 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/dbus/0.9.12/download) |
| defmt | 1.1.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/defmt/1.1.1/download) |
| defmt-macros | 1.1.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/defmt-macros/1.1.1/download) |
| defmt-parser | 1.0.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/defmt-parser/1.0.0/download) |
| deranged | 0.5.8 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/deranged/0.5.8/download) |
| derive_more | 2.1.1 | MIT | [version source](https://crates.io/api/v1/crates/derive_more/2.1.1/download) |
| derive_more-impl | 2.1.1 | MIT | [version source](https://crates.io/api/v1/crates/derive_more-impl/2.1.1/download) |
| digest | 0.10.7 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/digest/0.10.7/download) |
| digest | 0.11.3 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/digest/0.11.3/download) |
| dirs | 7.0.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/dirs/7.0.0/download) |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/dirs-sys/0.5.0/download) |
| dispatch2 | 0.3.1 | Zlib OR Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/dispatch2/0.3.1/download) |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/displaydoc/0.2.7/download) |
| dlopen2 | 0.8.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/dlopen2/0.8.2/download) |
| dlopen2_derive | 0.4.3 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/dlopen2_derive/0.4.3/download) |
| dom_query | 0.28.0 | MIT | [version source](https://crates.io/api/v1/crates/dom_query/0.28.0/download) |
| dpi | 0.1.2 | Apache-2.0 AND MIT | [version source](https://crates.io/api/v1/crates/dpi/0.1.2/download) |
| dtoa | 1.0.11 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/dtoa/1.0.11/download) |
| dtoa-short | 0.3.5 | MPL-2.0 | [version source](https://crates.io/api/v1/crates/dtoa-short/0.3.5/download) |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/dunce/1.0.5/download) |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/dyn-clone/1.0.20/download) |
| embed-resource | 3.0.11 | MIT | [version source](https://crates.io/api/v1/crates/embed-resource/3.0.11/download) |
| embed_plist | 1.2.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/embed_plist/1.2.2/download) |
| encoding_rs | 0.8.42 | (Apache-2.0 OR MIT) AND BSD-3-Clause | [version source](https://crates.io/api/v1/crates/encoding_rs/0.8.42/download) |
| endi | 1.1.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/endi/1.1.1/download) |
| enumflags2 | 0.7.12 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/enumflags2/0.7.12/download) |
| enumflags2_derive | 0.7.12 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/enumflags2_derive/0.7.12/download) |
| equivalent | 1.0.2 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/equivalent/1.0.2/download) |
| erased-serde | 0.4.10 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/erased-serde/0.4.10/download) |
| errno | 0.3.14 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/errno/0.3.14/download) |
| event-listener | 5.4.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/event-listener/5.4.2/download) |
| event-listener-strategy | 0.5.4 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/event-listener-strategy/0.5.4/download) |
| fallible-iterator | 0.3.0 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/fallible-iterator/0.3.0/download) |
| fallible-streaming-iterator | 0.1.9 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/fallible-streaming-iterator/0.1.9/download) |
| fastrand | 2.5.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/fastrand/2.5.0/download) |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/fdeflate/0.3.7/download) |
| field-offset | 0.3.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/field-offset/0.3.6/download) |
| find-msvc-tools | 0.1.14 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/find-msvc-tools/0.1.14/download) |
| flate2 | 1.1.10 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/flate2/1.1.10/download) |
| fnv | 1.0.7 | Apache-2.0 / MIT | [version source](https://crates.io/api/v1/crates/fnv/1.0.7/download) |
| foldhash | 0.2.0 | Zlib | [version source](https://crates.io/api/v1/crates/foldhash/0.2.0/download) |
| foreign-types | 0.5.0 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/foreign-types/0.5.0/download) |
| foreign-types-macros | 0.2.4 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/foreign-types-macros/0.2.4/download) |
| foreign-types-shared | 0.3.1 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/foreign-types-shared/0.3.1/download) |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/form_urlencoded/1.2.2/download) |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/futures-channel/0.3.34/download) |
| futures-core | 0.3.34 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/futures-core/0.3.34/download) |
| futures-executor | 0.3.34 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/futures-executor/0.3.34/download) |
| futures-io | 0.3.34 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/futures-io/0.3.34/download) |
| futures-lite | 2.6.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/futures-lite/2.6.1/download) |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/futures-macro/0.3.34/download) |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/futures-sink/0.3.34/download) |
| futures-task | 0.3.34 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/futures-task/0.3.34/download) |
| futures-util | 0.3.34 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/futures-util/0.3.34/download) |
| gdk | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gdk/0.18.2/download) |
| gdk-pixbuf | 0.18.5 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gdk-pixbuf/0.18.5/download) |
| gdk-pixbuf-sys | 0.18.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gdk-pixbuf-sys/0.18.0/download) |
| gdk-sys | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gdk-sys/0.18.2/download) |
| gdkwayland-sys | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gdkwayland-sys/0.18.2/download) |
| gdkx11 | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gdkx11/0.18.2/download) |
| gdkx11-sys | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gdkx11-sys/0.18.2/download) |
| generic-array | 0.14.7 | MIT | [version source](https://crates.io/api/v1/crates/generic-array/0.14.7/download) |
| getrandom | 0.2.17 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/getrandom/0.2.17/download) |
| getrandom | 0.3.4 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/getrandom/0.3.4/download) |
| getrandom | 0.4.3 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/getrandom/0.4.3/download) |
| gio | 0.18.4 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gio/0.18.4/download) |
| gio-sys | 0.18.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gio-sys/0.18.1/download) |
| glib | 0.18.5 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/glib/0.18.5/download) |
| glib-macros | 0.18.5 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/glib-macros/0.18.5/download) |
| glib-sys | 0.18.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/glib-sys/0.18.1/download) |
| glob | 0.3.4 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/glob/0.3.4/download) |
| gobject-sys | 0.18.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gobject-sys/0.18.0/download) |
| gtk | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gtk/0.18.2/download) |
| gtk-sys | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gtk-sys/0.18.2/download) |
| gtk3-macros | 0.18.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/gtk3-macros/0.18.2/download) |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/hashbrown/0.12.3/download) |
| hashbrown | 0.16.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/hashbrown/0.16.1/download) |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/hashbrown/0.17.1/download) |
| hashlink | 0.12.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/hashlink/0.12.2/download) |
| heck | 0.4.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/heck/0.4.1/download) |
| heck | 0.5.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/heck/0.5.0/download) |
| hermit-abi | 0.5.3 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/hermit-abi/0.5.3/download) |
| hex | 0.4.3 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/hex/0.4.3/download) |
| hkdf | 0.13.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/hkdf/0.13.0/download) |
| hmac | 0.13.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/hmac/0.13.0/download) |
| html5ever | 0.39.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/html5ever/0.39.0/download) |
| http | 1.5.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/http/1.5.0/download) |
| http-body | 1.1.0 | MIT | [version source](https://crates.io/api/v1/crates/http-body/1.1.0/download) |
| http-body-util | 0.1.5 | MIT | [version source](https://crates.io/api/v1/crates/http-body-util/0.1.5/download) |
| httparse | 1.10.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/httparse/1.10.1/download) |
| hybrid-array | 0.4.15 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/hybrid-array/0.4.15/download) |
| hyper | 1.11.1 | MIT | [version source](https://crates.io/api/v1/crates/hyper/1.11.1/download) |
| hyper-util | 0.1.21 | MIT | [version source](https://crates.io/api/v1/crates/hyper-util/0.1.21/download) |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/iana-time-zone/0.1.65/download) |
| iana-time-zone-haiku | 0.1.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/iana-time-zone-haiku/0.1.2/download) |
| ico | 0.5.0 | MIT | [version source](https://crates.io/api/v1/crates/ico/0.5.0/download) |
| icu_collections | 2.3.0 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/icu_collections/2.3.0/download) |
| icu_locale_core | 2.3.0 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/icu_locale_core/2.3.0/download) |
| icu_normalizer | 2.3.0 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/icu_normalizer/2.3.0/download) |
| icu_normalizer_data | 2.3.0 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/icu_normalizer_data/2.3.0/download) |
| icu_properties | 2.3.0 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/icu_properties/2.3.0/download) |
| icu_properties_data | 2.3.0 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/icu_properties_data/2.3.0/download) |
| icu_provider | 2.3.1 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/icu_provider/2.3.1/download) |
| ident_case | 1.0.1 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/ident_case/1.0.1/download) |
| idna | 1.1.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/idna/1.1.0/download) |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/idna_adapter/1.2.2/download) |
| indexmap | 1.9.3 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/indexmap/1.9.3/download) |
| indexmap | 2.14.2 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/indexmap/2.14.2/download) |
| infer | 0.22.0 | MIT | [version source](https://crates.io/api/v1/crates/infer/0.22.0/download) |
| inout | 0.2.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/inout/0.2.2/download) |
| ipnet | 2.12.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/ipnet/2.12.2/download) |
| is-docker | 0.2.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/is-docker/0.2.0/download) |
| is-wsl | 0.4.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/is-wsl/0.4.0/download) |
| itoa | 1.0.18 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/itoa/1.0.18/download) |
| javascriptcore-rs | 1.1.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/javascriptcore-rs/1.1.2/download) |
| javascriptcore-rs-sys | 1.1.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/javascriptcore-rs-sys/1.1.1/download) |
| jiff | 0.2.37 | Unlicense OR MIT | [version source](https://crates.io/api/v1/crates/jiff/0.2.37/download) |
| jiff-core | 0.1.1 | Unlicense OR MIT | [version source](https://crates.io/api/v1/crates/jiff-core/0.1.1/download) |
| jiff-static | 0.2.37 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/jiff-static/0.2.37/download) |
| jiff-tzdb | 0.1.8 | Unlicense OR MIT | [version source](https://crates.io/api/v1/crates/jiff-tzdb/0.1.8/download) |
| jiff-tzdb-platform | 0.1.3 | Unlicense OR MIT | [version source](https://crates.io/api/v1/crates/jiff-tzdb-platform/0.1.3/download) |
| jni | 0.21.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/jni/0.21.1/download) |
| jni-sys | 0.3.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/jni-sys/0.3.1/download) |
| jni-sys | 0.4.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/jni-sys/0.4.1/download) |
| jni-sys-macros | 0.4.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/jni-sys-macros/0.4.1/download) |
| js-sys | 0.3.106 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/js-sys/0.3.106/download) |
| json-patch | 4.2.0 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/json-patch/4.2.0/download) |
| jsonptr | 0.7.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/jsonptr/0.7.1/download) |
| keyboard-types | 0.8.3 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/keyboard-types/0.8.3/download) |
| keyring | 4.2.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/keyring/4.2.0/download) |
| keyring-core | 1.0.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/keyring-core/1.0.0/download) |
| libappindicator | 0.9.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/libappindicator/0.9.0/download) |
| libappindicator-sys | 0.9.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/libappindicator-sys/0.9.0/download) |
| libc | 0.2.189 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/libc/0.2.189/download) |
| libdbus-sys | 0.2.7 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/libdbus-sys/0.2.7/download) |
| libloading | 0.7.4 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/libloading/0.7.4/download) |
| libredox | 0.1.25 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/libredox/0.1.25/download) |
| libsqlite3-sys | 0.38.2 | MIT | [version source](https://crates.io/api/v1/crates/libsqlite3-sys/0.38.2/download) |
| linux-raw-sys | 0.12.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/linux-raw-sys/0.12.1/download) |
| litemap | 0.8.3 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/litemap/0.8.3/download) |
| lock_api | 0.4.14 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/lock_api/0.4.14/download) |
| log | 0.4.34 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/log/0.4.34/download) |
| markup5ever | 0.39.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/markup5ever/0.39.0/download) |
| memchr | 2.8.3 | Unlicense OR MIT | [version source](https://crates.io/api/v1/crates/memchr/2.8.3/download) |
| memoffset | 0.9.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/memoffset/0.9.1/download) |
| mime | 0.3.17 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/mime/0.3.17/download) |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/miniz_oxide/0.8.9/download) |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/miniz_oxide/0.9.1/download) |
| mio | 1.2.3 | MIT | [version source](https://crates.io/api/v1/crates/mio/1.2.3/download) |
| muda | 0.20.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/muda/0.20.0/download) |
| multiversion_no_op | 1.0.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/multiversion_no_op/1.0.0/download) |
| ndk | 0.9.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/ndk/0.9.0/download) |
| ndk-context | 0.1.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/ndk-context/0.1.1/download) |
| ndk-sys | 0.6.0+11769913 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/ndk-sys/0.6.0+11769913/download) |
| new_debug_unreachable | 1.0.6 | MIT | [version source](https://crates.io/api/v1/crates/new_debug_unreachable/1.0.6/download) |
| num | 0.4.3 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/num/0.4.3/download) |
| num-bigint | 0.4.8 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/num-bigint/0.4.8/download) |
| num-complex | 0.4.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/num-complex/0.4.6/download) |
| num-conv | 0.2.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/num-conv/0.2.2/download) |
| num-integer | 0.1.47 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/num-integer/0.1.47/download) |
| num-iter | 0.1.46 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/num-iter/0.1.46/download) |
| num-rational | 0.4.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/num-rational/0.4.2/download) |
| num-traits | 0.2.19 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/num-traits/0.2.19/download) |
| num_enum | 0.7.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/num_enum/0.7.6/download) |
| num_enum_derive | 0.7.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/num_enum_derive/0.7.6/download) |
| objc2 | 0.6.4 | MIT | [version source](https://crates.io/api/v1/crates/objc2/0.6.4/download) |
| objc2-app-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/objc2-app-kit/0.3.2/download) |
| objc2-cloud-kit | 0.3.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/objc2-cloud-kit/0.3.2/download) |
| objc2-core-data | 0.3.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/objc2-core-data/0.3.2/download) |
| objc2-core-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/objc2-core-foundation/0.3.2/download) |
| objc2-core-graphics | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/objc2-core-graphics/0.3.2/download) |
| objc2-core-image | 0.3.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/objc2-core-image/0.3.2/download) |
| objc2-core-location | 0.3.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/objc2-core-location/0.3.2/download) |
| objc2-core-text | 0.3.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/objc2-core-text/0.3.2/download) |
| objc2-encode | 4.1.0 | MIT | [version source](https://crates.io/api/v1/crates/objc2-encode/4.1.0/download) |
| objc2-exception-helper | 0.1.1 | Zlib OR Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/objc2-exception-helper/0.1.1/download) |
| objc2-foundation | 0.3.2 | MIT | [version source](https://crates.io/api/v1/crates/objc2-foundation/0.3.2/download) |
| objc2-io-surface | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/objc2-io-surface/0.3.2/download) |
| objc2-quartz-core | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/objc2-quartz-core/0.3.2/download) |
| objc2-ui-kit | 0.3.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/objc2-ui-kit/0.3.2/download) |
| objc2-user-notifications | 0.3.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/objc2-user-notifications/0.3.2/download) |
| objc2-web-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/objc2-web-kit/0.3.2/download) |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/once_cell/1.21.4/download) |
| open | 5.4.4 | MIT | [version source](https://crates.io/api/v1/crates/open/5.4.4/download) |
| option-ext | 0.2.0 | MPL-2.0 | [version source](https://crates.io/api/v1/crates/option-ext/0.2.0/download) |
| ordered-stream | 0.2.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/ordered-stream/0.2.0/download) |
| os_pipe | 1.2.3 | MIT | [version source](https://crates.io/api/v1/crates/os_pipe/1.2.3/download) |
| pango | 0.18.3 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/pango/0.18.3/download) |
| pango-sys | 0.18.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/pango-sys/0.18.0/download) |
| parking | 2.2.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/parking/2.2.1/download) |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/parking_lot/0.12.5/download) |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/parking_lot_core/0.9.12/download) |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/percent-encoding/2.3.2/download) |
| phf | 0.13.1 | MIT | [version source](https://crates.io/api/v1/crates/phf/0.13.1/download) |
| phf_codegen | 0.13.1 | MIT | [version source](https://crates.io/api/v1/crates/phf_codegen/0.13.1/download) |
| phf_generator | 0.13.1 | MIT | [version source](https://crates.io/api/v1/crates/phf_generator/0.13.1/download) |
| phf_macros | 0.13.1 | MIT | [version source](https://crates.io/api/v1/crates/phf_macros/0.13.1/download) |
| phf_shared | 0.13.1 | MIT | [version source](https://crates.io/api/v1/crates/phf_shared/0.13.1/download) |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/pin-project-lite/0.2.17/download) |
| piper | 0.2.5 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/piper/0.2.5/download) |
| pkg-config | 0.3.34 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/pkg-config/0.3.34/download) |
| plist | 1.10.1 | MIT | [version source](https://crates.io/api/v1/crates/plist/1.10.1/download) |
| png | 0.17.16 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/png/0.17.16/download) |
| png | 0.18.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/png/0.18.1/download) |
| polling | 3.11.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/polling/3.11.0/download) |
| portable-atomic | 1.15.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/portable-atomic/1.15.0/download) |
| portable-atomic-util | 0.2.8 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/portable-atomic-util/0.2.8/download) |
| potential_utf | 0.1.6 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/potential_utf/0.1.6/download) |
| powerfmt | 0.2.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/powerfmt/0.2.0/download) |
| precomputed-hash | 0.1.1 | MIT | [version source](https://crates.io/api/v1/crates/precomputed-hash/0.1.1/download) |
| proc-macro-crate | 1.3.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/proc-macro-crate/1.3.1/download) |
| proc-macro-crate | 2.0.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/proc-macro-crate/2.0.2/download) |
| proc-macro-crate | 3.5.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/proc-macro-crate/3.5.0/download) |
| proc-macro-error | 1.0.4 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/proc-macro-error/1.0.4/download) |
| proc-macro-error-attr | 1.0.4 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/proc-macro-error-attr/1.0.4/download) |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/proc-macro2/1.0.107/download) |
| quick-xml | 0.42.0 | MIT | [version source](https://crates.io/api/v1/crates/quick-xml/0.42.0/download) |
| quote | 1.0.47 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/quote/1.0.47/download) |
| r-efi | 5.3.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/r-efi/5.3.0/download) |
| r-efi | 6.0.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/r-efi/6.0.0/download) |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib | [version source](https://crates.io/api/v1/crates/raw-window-handle/0.6.2/download) |
| redox_syscall | 0.5.18 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/redox_syscall/0.5.18/download) |
| redox_users | 0.5.3 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/redox_users/0.5.3/download) |
| ref-cast | 1.0.27 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/ref-cast/1.0.27/download) |
| ref-cast-impl | 1.0.27 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/ref-cast-impl/1.0.27/download) |
| regex | 1.13.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/regex/1.13.1/download) |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/regex-automata/0.4.18/download) |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/regex-syntax/0.8.11/download) |
| reqwest | 0.13.5 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/reqwest/0.13.5/download) |
| rfd | 0.16.0 | MIT | [version source](https://crates.io/api/v1/crates/rfd/0.16.0/download) |
| ring | 0.17.14 | Apache-2.0 AND ISC | [version source](https://crates.io/api/v1/crates/ring/0.17.14/download) |
| rsqlite-vfs | 0.1.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/rsqlite-vfs/0.1.1/download) |
| rusqlite | 0.40.2 | MIT | [version source](https://crates.io/api/v1/crates/rusqlite/0.40.2/download) |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/rustc-hash/2.1.3/download) |
| rustc_version | 0.4.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/rustc_version/0.4.1/download) |
| rustix | 1.1.5 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/rustix/1.1.5/download) |
| rustversion | 1.0.23 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/rustversion/1.0.23/download) |
| same-file | 1.0.6 | Unlicense/MIT | [version source](https://crates.io/api/v1/crates/same-file/1.0.6/download) |
| schemars | 0.8.22 | MIT | [version source](https://crates.io/api/v1/crates/schemars/0.8.22/download) |
| schemars | 0.9.0 | MIT | [version source](https://crates.io/api/v1/crates/schemars/0.9.0/download) |
| schemars | 1.2.2 | MIT | [version source](https://crates.io/api/v1/crates/schemars/1.2.2/download) |
| schemars_derive | 0.8.22 | MIT | [version source](https://crates.io/api/v1/crates/schemars_derive/0.8.22/download) |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/scopeguard/1.2.0/download) |
| secret-service | 5.2.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/secret-service/5.2.0/download) |
| security-framework | 3.7.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/security-framework/3.7.0/download) |
| security-framework-sys | 2.17.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/security-framework-sys/2.17.0/download) |
| selectors | 0.38.0 | MPL-2.0 | [version source](https://crates.io/api/v1/crates/selectors/0.38.0/download) |
| semver | 1.0.28 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/semver/1.0.28/download) |
| serde | 1.0.229 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serde/1.0.229/download) |
| serde-untagged | 0.1.9 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serde-untagged/0.1.9/download) |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serde_core/1.0.229/download) |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serde_derive/1.0.229/download) |
| serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serde_derive_internals/0.29.1/download) |
| serde_json | 1.0.151 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serde_json/1.0.151/download) |
| serde_repr | 0.1.21 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serde_repr/0.1.21/download) |
| serde_spanned | 0.6.9 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/serde_spanned/0.6.9/download) |
| serde_spanned | 1.1.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serde_spanned/1.1.1/download) |
| serde_with | 3.24.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serde_with/3.24.0/download) |
| serde_with_macros | 3.24.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serde_with_macros/3.24.0/download) |
| serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serialize-to-javascript/0.1.2/download) |
| serialize-to-javascript-impl | 0.1.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/serialize-to-javascript-impl/0.1.2/download) |
| servo_arc | 0.4.3 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/servo_arc/0.4.3/download) |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/sha2/0.10.9/download) |
| sha2 | 0.11.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/sha2/0.11.0/download) |
| shared_child | 1.1.2 | MIT | [version source](https://crates.io/api/v1/crates/shared_child/1.1.2/download) |
| shlex | 2.0.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/shlex/2.0.1/download) |
| sigchld | 0.2.5 | MIT | [version source](https://crates.io/api/v1/crates/sigchld/0.2.5/download) |
| signal-hook | 0.4.4 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/signal-hook/0.4.4/download) |
| signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/signal-hook-registry/1.4.8/download) |
| simd-adler32 | 0.3.10 | MIT | [version source](https://crates.io/api/v1/crates/simd-adler32/0.3.10/download) |
| simdutf8 | 0.1.5 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/simdutf8/0.1.5/download) |
| siphasher | 1.0.4 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/siphasher/1.0.4/download) |
| slab | 0.4.12 | MIT | [version source](https://crates.io/api/v1/crates/slab/0.4.12/download) |
| smallvec | 1.16.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/smallvec/1.16.2/download) |
| socket2 | 0.6.5 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/socket2/0.6.5/download) |
| softbuffer | 0.4.8 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/softbuffer/0.4.8/download) |
| soup3 | 0.5.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/soup3/0.5.0/download) |
| soup3-sys | 0.5.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/soup3-sys/0.5.0/download) |
| sqlite-wasm-rs | 0.5.5 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/sqlite-wasm-rs/0.5.5/download) |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/stable_deref_trait/1.2.1/download) |
| string_cache | 0.9.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/string_cache/0.9.0/download) |
| string_cache_codegen | 0.6.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/string_cache_codegen/0.6.1/download) |
| strsim | 0.11.1 | MIT | [version source](https://crates.io/api/v1/crates/strsim/0.11.1/download) |
| swift-rs | 1.0.8 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/swift-rs/1.0.8/download) |
| syn | 1.0.109 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/syn/1.0.109/download) |
| syn | 2.0.119 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/syn/2.0.119/download) |
| syn | 3.0.6 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/syn/3.0.6/download) |
| sync_wrapper | 1.0.2 | Apache-2.0 | [version source](https://crates.io/api/v1/crates/sync_wrapper/1.0.2/download) |
| synstructure | 0.14.0 | MIT | [version source](https://crates.io/api/v1/crates/synstructure/0.14.0/download) |
| system-deps | 6.2.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/system-deps/6.2.2/download) |
| tao | 0.37.1 | Apache-2.0 | [version source](https://crates.io/api/v1/crates/tao/0.37.1/download) |
| tao-macros | 0.1.4 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/tao-macros/0.1.4/download) |
| target-lexicon | 0.12.16 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/target-lexicon/0.12.16/download) |
| tauri | 2.12.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri/2.12.0/download) |
| tauri-build | 2.7.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-build/2.7.0/download) |
| tauri-codegen | 2.7.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-codegen/2.7.0/download) |
| tauri-macros | 2.7.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-macros/2.7.0/download) |
| tauri-plugin | 2.7.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-plugin/2.7.0/download) |
| tauri-plugin-dialog | 2.8.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-plugin-dialog/2.8.0/download) |
| tauri-plugin-fs | 2.6.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-plugin-fs/2.6.0/download) |
| tauri-plugin-shell | 2.4.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-plugin-shell/2.4.0/download) |
| tauri-plugin-single-instance | 2.5.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-plugin-single-instance/2.5.0/download) |
| tauri-runtime | 2.12.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-runtime/2.12.0/download) |
| tauri-runtime-wry | 2.12.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-runtime-wry/2.12.0/download) |
| tauri-utils | 2.10.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tauri-utils/2.10.0/download) |
| tauri-winres | 0.3.6 | MIT | [version source](https://crates.io/api/v1/crates/tauri-winres/0.3.6/download) |
| tempfile | 3.27.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/tempfile/3.27.0/download) |
| tendril | 0.5.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/tendril/0.5.1/download) |
| thiserror | 1.0.69 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/thiserror/1.0.69/download) |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/thiserror/2.0.21/download) |
| thiserror-impl | 1.0.69 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/thiserror-impl/1.0.69/download) |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/thiserror-impl/2.0.21/download) |
| time | 0.3.55 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/time/0.3.55/download) |
| time-core | 0.1.9 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/time-core/0.1.9/download) |
| time-macros | 0.2.32 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/time-macros/0.2.32/download) |
| tinystr | 0.8.4 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/tinystr/0.8.4/download) |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/tinyvec/1.13.3/download) |
| tokio | 1.53.1 | MIT | [version source](https://crates.io/api/v1/crates/tokio/1.53.1/download) |
| tokio-util | 0.7.19 | MIT | [version source](https://crates.io/api/v1/crates/tokio-util/0.7.19/download) |
| toml | 0.8.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/toml/0.8.2/download) |
| toml | 1.1.6+spec-1.1.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/toml/1.1.6+spec-1.1.0/download) |
| toml_datetime | 0.6.3 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/toml_datetime/0.6.3/download) |
| toml_datetime | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/toml_datetime/1.1.1+spec-1.1.0/download) |
| toml_edit | 0.19.15 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/toml_edit/0.19.15/download) |
| toml_edit | 0.20.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/toml_edit/0.20.2/download) |
| toml_edit | 0.25.15+spec-1.1.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/toml_edit/0.25.15+spec-1.1.0/download) |
| toml_parser | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/toml_parser/1.1.3+spec-1.1.0/download) |
| toml_writer | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/toml_writer/1.1.2+spec-1.1.0/download) |
| tower | 0.5.3 | MIT | [version source](https://crates.io/api/v1/crates/tower/0.5.3/download) |
| tower-http | 0.6.11 | MIT | [version source](https://crates.io/api/v1/crates/tower-http/0.6.11/download) |
| tower-layer | 0.3.3 | MIT | [version source](https://crates.io/api/v1/crates/tower-layer/0.3.3/download) |
| tower-service | 0.3.3 | MIT | [version source](https://crates.io/api/v1/crates/tower-service/0.3.3/download) |
| tracing | 0.1.44 | MIT | [version source](https://crates.io/api/v1/crates/tracing/0.1.44/download) |
| tracing-attributes | 0.1.31 | MIT | [version source](https://crates.io/api/v1/crates/tracing-attributes/0.1.31/download) |
| tracing-core | 0.1.36 | MIT | [version source](https://crates.io/api/v1/crates/tracing-core/0.1.36/download) |
| tray-icon | 0.25.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/tray-icon/0.25.1/download) |
| try-lock | 0.2.5 | MIT | [version source](https://crates.io/api/v1/crates/try-lock/0.2.5/download) |
| typeid | 1.0.3 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/typeid/1.0.3/download) |
| typenum | 1.20.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/typenum/1.20.1/download) |
| uds_windows | 1.2.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/uds_windows/1.2.1/download) |
| unicode-ident | 1.0.26 | (MIT OR Apache-2.0) AND Unicode-3.0 | [version source](https://crates.io/api/v1/crates/unicode-ident/1.0.26/download) |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/unicode-segmentation/1.13.3/download) |
| untrusted | 0.9.0 | ISC | [version source](https://crates.io/api/v1/crates/untrusted/0.9.0/download) |
| url | 2.5.8 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/url/2.5.8/download) |
| urlpattern | 0.6.0 | MIT | [version source](https://crates.io/api/v1/crates/urlpattern/0.6.0/download) |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/utf8_iter/1.0.4/download) |
| uuid | 1.26.1 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/uuid/1.26.1/download) |
| vcpkg | 0.2.15 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/vcpkg/0.2.15/download) |
| version-compare | 0.2.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/version-compare/0.2.1/download) |
| version_check | 0.9.5 | MIT/Apache-2.0 | [version source](https://crates.io/api/v1/crates/version_check/0.9.5/download) |
| vswhom | 0.1.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/vswhom/0.1.0/download) |
| vswhom-sys | 0.1.3 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/vswhom-sys/0.1.3/download) |
| walkdir | 2.5.0 | Unlicense/MIT | [version source](https://crates.io/api/v1/crates/walkdir/2.5.0/download) |
| want | 0.3.1 | MIT | [version source](https://crates.io/api/v1/crates/want/0.3.1/download) |
| wasi | 0.11.1+wasi-snapshot-preview1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/wasi/0.11.1+wasi-snapshot-preview1/download) |
| wasip2 | 1.0.4+wasi-0.2.12 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/wasip2/1.0.4+wasi-0.2.12/download) |
| wasm-bindgen | 0.2.129 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/wasm-bindgen/0.2.129/download) |
| wasm-bindgen-futures | 0.4.79 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/wasm-bindgen-futures/0.4.79/download) |
| wasm-bindgen-macro | 0.2.129 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/wasm-bindgen-macro/0.2.129/download) |
| wasm-bindgen-macro-support | 0.2.129 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/wasm-bindgen-macro-support/0.2.129/download) |
| wasm-bindgen-shared | 0.2.129 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/wasm-bindgen-shared/0.2.129/download) |
| wasm-streams | 0.5.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/wasm-streams/0.5.0/download) |
| web-sys | 0.3.106 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/web-sys/0.3.106/download) |
| web-time | 1.1.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/web-time/1.1.0/download) |
| web_atoms | 0.2.6 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/web_atoms/0.2.6/download) |
| webkit2gtk | 2.0.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/webkit2gtk/2.0.2/download) |
| webkit2gtk-sys | 2.0.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/webkit2gtk-sys/2.0.2/download) |
| webview2-com | 0.39.1 | MIT | [version source](https://crates.io/api/v1/crates/webview2-com/0.39.1/download) |
| webview2-com-macros | 0.8.1 | MIT | [version source](https://crates.io/api/v1/crates/webview2-com-macros/0.8.1/download) |
| webview2-com-sys | 0.39.1 | MIT | [version source](https://crates.io/api/v1/crates/webview2-com-sys/0.39.1/download) |
| winapi | 0.3.9 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/winapi/0.3.9/download) |
| winapi-i686-pc-windows-gnu | 0.4.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/winapi-i686-pc-windows-gnu/0.4.0/download) |
| winapi-util | 0.1.11 | Unlicense OR MIT | [version source](https://crates.io/api/v1/crates/winapi-util/0.1.11/download) |
| winapi-x86_64-pc-windows-gnu | 0.4.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/winapi-x86_64-pc-windows-gnu/0.4.0/download) |
| window-vibrancy | 0.8.1 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/window-vibrancy/0.8.1/download) |
| windows | 0.62.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows/0.62.2/download) |
| windows-collections | 0.3.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-collections/0.3.2/download) |
| windows-core | 0.62.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-core/0.62.2/download) |
| windows-future | 0.3.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-future/0.3.2/download) |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-implement/0.60.2/download) |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-interface/0.59.3/download) |
| windows-link | 0.2.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-link/0.2.1/download) |
| windows-native-keyring-store | 1.1.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-native-keyring-store/1.1.0/download) |
| windows-numerics | 0.3.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-numerics/0.3.1/download) |
| windows-result | 0.4.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-result/0.4.1/download) |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-strings/0.5.1/download) |
| windows-sys | 0.45.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows-sys/0.45.0/download) |
| windows-sys | 0.52.0 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-sys/0.52.0/download) |
| windows-sys | 0.59.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows-sys/0.59.0/download) |
| windows-sys | 0.60.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-sys/0.60.2/download) |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-sys/0.61.2/download) |
| windows-targets | 0.42.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows-targets/0.42.2/download) |
| windows-targets | 0.52.6 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-targets/0.52.6/download) |
| windows-targets | 0.53.5 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-targets/0.53.5/download) |
| windows-threading | 0.2.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-threading/0.2.1/download) |
| windows-version | 0.1.7 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows-version/0.1.7/download) |
| windows_aarch64_gnullvm | 0.42.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_aarch64_gnullvm/0.42.2/download) |
| windows_aarch64_gnullvm | 0.52.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_aarch64_gnullvm/0.52.6/download) |
| windows_aarch64_gnullvm | 0.53.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_aarch64_gnullvm/0.53.1/download) |
| windows_aarch64_msvc | 0.42.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_aarch64_msvc/0.42.2/download) |
| windows_aarch64_msvc | 0.52.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_aarch64_msvc/0.52.6/download) |
| windows_aarch64_msvc | 0.53.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_aarch64_msvc/0.53.1/download) |
| windows_i686_gnu | 0.42.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_i686_gnu/0.42.2/download) |
| windows_i686_gnu | 0.52.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_i686_gnu/0.52.6/download) |
| windows_i686_gnu | 0.53.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_i686_gnu/0.53.1/download) |
| windows_i686_gnullvm | 0.52.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_i686_gnullvm/0.52.6/download) |
| windows_i686_gnullvm | 0.53.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_i686_gnullvm/0.53.1/download) |
| windows_i686_msvc | 0.42.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_i686_msvc/0.42.2/download) |
| windows_i686_msvc | 0.52.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_i686_msvc/0.52.6/download) |
| windows_i686_msvc | 0.53.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_i686_msvc/0.53.1/download) |
| windows_x86_64_gnu | 0.42.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_x86_64_gnu/0.42.2/download) |
| windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows_x86_64_gnu/0.52.6/download) |
| windows_x86_64_gnu | 0.53.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/windows_x86_64_gnu/0.53.1/download) |
| windows_x86_64_gnullvm | 0.42.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_x86_64_gnullvm/0.42.2/download) |
| windows_x86_64_gnullvm | 0.52.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_x86_64_gnullvm/0.52.6/download) |
| windows_x86_64_gnullvm | 0.53.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_x86_64_gnullvm/0.53.1/download) |
| windows_x86_64_msvc | 0.42.2 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_x86_64_msvc/0.42.2/download) |
| windows_x86_64_msvc | 0.52.6 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_x86_64_msvc/0.52.6/download) |
| windows_x86_64_msvc | 0.53.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/windows_x86_64_msvc/0.53.1/download) |
| winnow | 0.5.40 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/winnow/0.5.40/download) |
| winnow | 1.0.4 | MIT | [version source](https://crates.io/api/v1/crates/winnow/1.0.4/download) |
| winreg | 0.55.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/winreg/0.55.0/download) |
| wit-bindgen | 0.57.1 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/wit-bindgen/0.57.1/download) |
| writeable | 0.6.4 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/writeable/0.6.4/download) |
| wry | 0.57.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/wry/0.57.0/download) |
| x11 | 2.21.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/x11/2.21.0/download) |
| x11-dl | 2.21.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/x11-dl/2.21.0/download) |
| yoke | 0.8.3 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/yoke/0.8.3/download) |
| yoke-derive | 0.8.3 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/yoke-derive/0.8.3/download) |
| zbus | 5.19.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/zbus/5.19.0/download) |
| zbus-secret-service-keyring-store | 1.0.1 | MIT OR Apache-2.0 | [version source](https://crates.io/api/v1/crates/zbus-secret-service-keyring-store/1.0.1/download) |
| zbus_macros | 5.19.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/zbus_macros/5.19.0/download) |
| zbus_names | 4.3.4 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/zbus_names/4.3.4/download) |
| zcheapstr | 1.1.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/zcheapstr/1.1.0/download) |
| zerofrom | 0.1.8 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/zerofrom/0.1.8/download) |
| zerofrom-derive | 0.1.8 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/zerofrom-derive/0.1.8/download) |
| zeroize | 1.9.0 | Apache-2.0 OR MIT | [version source](https://crates.io/api/v1/crates/zeroize/1.9.0/download) |
| zerotrie | 0.2.5 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/zerotrie/0.2.5/download) |
| zerovec | 0.11.8 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/zerovec/0.11.8/download) |
| zerovec-derive | 0.11.6 | Unicode-3.0 | [version source](https://crates.io/api/v1/crates/zerovec-derive/0.11.6/download) |
| zlib-rs | 0.6.8 | Zlib | [version source](https://crates.io/api/v1/crates/zlib-rs/0.6.8/download) |
| zmij | 1.0.23 | MIT | [version source](https://crates.io/api/v1/crates/zmij/1.0.23/download) |
| zvariant | 5.15.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/zvariant/5.15.0/download) |
| zvariant_derive | 5.15.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/zvariant_derive/5.15.0/download) |
| zvariant_utils | 4.2.0 | UNVERIFIED | [version source](https://crates.io/api/v1/crates/zvariant_utils/4.2.0/download) |

## JavaScript / pnpm 설치 metadata

| Package | Version | License metadata | Source |
| --- | --- | --- | --- |
| @axe-core/playwright | 4.13.0 | MPL-2.0 | [package](https://www.npmjs.com/package/@axe-core/playwright/v/4.13.0) |
| @jridgewell/gen-mapping | 0.3.13 | MIT | [package](https://www.npmjs.com/package/@jridgewell/gen-mapping/v/0.3.13) |
| @jridgewell/remapping | 2.3.5 | MIT | [package](https://www.npmjs.com/package/@jridgewell/remapping/v/2.3.5) |
| @jridgewell/resolve-uri | 3.1.2 | MIT | [package](https://www.npmjs.com/package/@jridgewell/resolve-uri/v/3.1.2) |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT | [package](https://www.npmjs.com/package/@jridgewell/sourcemap-codec/v/1.6.0) |
| @jridgewell/trace-mapping | 0.3.31 | MIT | [package](https://www.npmjs.com/package/@jridgewell/trace-mapping/v/0.3.31) |
| @oxc-project/types | 0.151.0 | MIT | [package](https://www.npmjs.com/package/@oxc-project/types/v/0.151.0) |
| @playwright/test | 1.63.0 | Apache-2.0 | [package](https://www.npmjs.com/package/@playwright/test/v/1.63.0) |
| @rolldown/binding-darwin-arm64 | 1.2.11 | MIT | [package](https://www.npmjs.com/package/@rolldown/binding-darwin-arm64/v/1.2.11) |
| @rolldown/pluginutils | 1.0.1 | MIT | [package](https://www.npmjs.com/package/@rolldown/pluginutils/v/1.0.1) |
| @sveltejs/acorn-typescript | 1.0.13 | MIT | [package](https://www.npmjs.com/package/@sveltejs/acorn-typescript/v/1.0.13) |
| @sveltejs/load-config | 0.2.3 | MIT | [package](https://www.npmjs.com/package/@sveltejs/load-config/v/0.2.3) |
| @sveltejs/vite-plugin-svelte | 7.3.1 | MIT | [package](https://www.npmjs.com/package/@sveltejs/vite-plugin-svelte/v/7.3.1) |
| @tauri-apps/api | 2.12.0 | Apache-2.0 OR MIT | [package](https://www.npmjs.com/package/@tauri-apps/api/v/2.12.0) |
| @tauri-apps/cli | 2.12.0 | Apache-2.0 OR MIT | [package](https://www.npmjs.com/package/@tauri-apps/cli/v/2.12.0) |
| @tauri-apps/cli-darwin-arm64 | 2.12.0 | Apache-2.0 OR MIT | [package](https://www.npmjs.com/package/@tauri-apps/cli-darwin-arm64/v/2.12.0) |
| @tauri-apps/plugin-dialog | 2.8.0 | MIT OR Apache-2.0 | [package](https://www.npmjs.com/package/@tauri-apps/plugin-dialog/v/2.8.0) |
| @types/chai | 5.2.3 | MIT | [package](https://www.npmjs.com/package/@types/chai/v/5.2.3) |
| @types/deep-eql | 4.0.2 | MIT | [package](https://www.npmjs.com/package/@types/deep-eql/v/4.0.2) |
| @types/estree | 1.0.9 | MIT | [package](https://www.npmjs.com/package/@types/estree/v/1.0.9) |
| @types/node | 26.6.3 | MIT | [package](https://www.npmjs.com/package/@types/node/v/26.6.3) |
| @vitest/mocker | 5.0.2 | MIT | [package](https://www.npmjs.com/package/@vitest/mocker/v/5.0.2) |
| @vitest/spy | 5.0.2 | MIT | [package](https://www.npmjs.com/package/@vitest/spy/v/5.0.2) |
| acorn | 8.18.0 | MIT | [package](https://www.npmjs.com/package/acorn/v/8.18.0) |
| aria-query | 5.3.1 | Apache-2.0 | [package](https://www.npmjs.com/package/aria-query/v/5.3.1) |
| assertion-error | 2.0.1 | MIT | [package](https://www.npmjs.com/package/assertion-error/v/2.0.1) |
| axe-core | 4.13.0 | MPL-2.0 | [package](https://www.npmjs.com/package/axe-core/v/4.13.0) |
| axobject-query | 4.1.0 | Apache-2.0 | [package](https://www.npmjs.com/package/axobject-query/v/4.1.0) |
| chai | 6.2.2 | MIT | [package](https://www.npmjs.com/package/chai/v/6.2.2) |
| chokidar | 4.0.3 | MIT | [package](https://www.npmjs.com/package/chokidar/v/4.0.3) |
| clsx | 2.1.1 | MIT | [package](https://www.npmjs.com/package/clsx/v/2.1.1) |
| deepmerge | 4.3.1 | MIT | [package](https://www.npmjs.com/package/deepmerge/v/4.3.1) |
| detect-libc | 2.1.2 | Apache-2.0 | [package](https://www.npmjs.com/package/detect-libc/v/2.1.2) |
| devalue | 5.9.4 | MIT | [package](https://www.npmjs.com/package/devalue/v/5.9.4) |
| es-module-lexer | 2.3.2 | MIT | [package](https://www.npmjs.com/package/es-module-lexer/v/2.3.2) |
| esm-env | 1.2.2 | MIT | [package](https://www.npmjs.com/package/esm-env/v/1.2.2) |
| esrap | 2.4.0 | MIT | [package](https://www.npmjs.com/package/esrap/v/2.4.0) |
| estree-walker | 3.0.3 | MIT | [package](https://www.npmjs.com/package/estree-walker/v/3.0.3) |
| expect-type | 1.4.0 | Apache-2.0 | [package](https://www.npmjs.com/package/expect-type/v/1.4.0) |
| fdir | 6.5.0 | MIT | [package](https://www.npmjs.com/package/fdir/v/6.5.0) |
| fsevents | 2.3.3 | MIT | [package](https://www.npmjs.com/package/fsevents/v/2.3.3) |
| is-reference | 3.0.3 | MIT | [package](https://www.npmjs.com/package/is-reference/v/3.0.3) |
| lightningcss | 1.33.0 | MPL-2.0 | [package](https://www.npmjs.com/package/lightningcss/v/1.33.0) |
| lightningcss-darwin-arm64 | 1.33.0 | MPL-2.0 | [package](https://www.npmjs.com/package/lightningcss-darwin-arm64/v/1.33.0) |
| locate-character | 3.0.0 | MIT | [package](https://www.npmjs.com/package/locate-character/v/3.0.0) |
| magic-string | 0.30.21 | MIT | [package](https://www.npmjs.com/package/magic-string/v/0.30.21) |
| magic-string | 1.4.2 | MIT | [package](https://www.npmjs.com/package/magic-string/v/1.4.2) |
| mri | 1.2.0 | MIT | [package](https://www.npmjs.com/package/mri/v/1.2.0) |
| nanoid | 3.3.19 | MIT | [package](https://www.npmjs.com/package/nanoid/v/3.3.19) |
| obug | 2.2.1 | MIT | [package](https://www.npmjs.com/package/obug/v/2.2.1) |
| picocolors | 1.1.1 | ISC | [package](https://www.npmjs.com/package/picocolors/v/1.1.1) |
| picomatch | 4.0.7 | MIT | [package](https://www.npmjs.com/package/picomatch/v/4.0.7) |
| playwright | 1.63.0 | Apache-2.0 | [package](https://www.npmjs.com/package/playwright/v/1.63.0) |
| playwright-core | 1.63.0 | Apache-2.0 | [package](https://www.npmjs.com/package/playwright-core/v/1.63.0) |
| postcss | 8.5.28 | MIT | [package](https://www.npmjs.com/package/postcss/v/8.5.28) |
| readdirp | 4.1.2 | MIT | [package](https://www.npmjs.com/package/readdirp/v/4.1.2) |
| rolldown | 1.2.11 | MIT | [package](https://www.npmjs.com/package/rolldown/v/1.2.11) |
| sade | 1.8.1 | MIT | [package](https://www.npmjs.com/package/sade/v/1.8.1) |
| source-map-js | 1.2.1 | BSD-3-Clause | [package](https://www.npmjs.com/package/source-map-js/v/1.2.1) |
| std-env | 4.2.0 | MIT | [package](https://www.npmjs.com/package/std-env/v/4.2.0) |
| svelte | 5.57.1 | MIT | [package](https://www.npmjs.com/package/svelte/v/5.57.1) |
| svelte-check | 4.7.6 | MIT | [package](https://www.npmjs.com/package/svelte-check/v/4.7.6) |
| tinybench | 6.2.0 | MIT | [package](https://www.npmjs.com/package/tinybench/v/6.2.0) |
| tinyexec | 1.3.1 | MIT | [package](https://www.npmjs.com/package/tinyexec/v/1.3.1) |
| tinyglobby | 0.2.17 | MIT | [package](https://www.npmjs.com/package/tinyglobby/v/0.2.17) |
| typescript | 5.9.3 | Apache-2.0 | [package](https://www.npmjs.com/package/typescript/v/5.9.3) |
| undici-types | 8.9.0 | MIT | [package](https://www.npmjs.com/package/undici-types/v/8.9.0) |
| vite | 8.3.1 | MIT | [package](https://www.npmjs.com/package/vite/v/8.3.1) |
| vitefu | 1.1.3 | MIT | [package](https://www.npmjs.com/package/vitefu/v/1.1.3) |
| vitest | 5.0.2 | MIT | [package](https://www.npmjs.com/package/vitest/v/5.0.2) |
| why-is-node-running | 3.2.2 | MIT | [package](https://www.npmjs.com/package/why-is-node-running/v/3.2.2) |
| zimmerframe | 1.1.5 | MIT | [package](https://www.npmjs.com/package/zimmerframe/v/1.1.5) |

## Python 설치 metadata

Python interpreter 및 표준 라이브러리 조건은 [Python 3.12 license](https://docs.python.org/3.12/license.html)를 별도로 확인합니다.

| Package | Version | License metadata | Source |
| --- | --- | --- | --- |
| NBT | 1.5.1 | MIT | [version source](https://pypi.org/project/NBT/1.5.1/#files) |
| altgraph | 0.17.5 | MIT | [version source](https://pypi.org/project/altgraph/0.17.5/#files) |
| jaraco.classes | 3.4.0 | MIT | [version source](https://pypi.org/project/jaraco.classes/3.4.0/#files) |
| jaraco.context | 6.1.2 | MIT | [version source](https://pypi.org/project/jaraco.context/6.1.2/#files) |
| jaraco.functools | 4.6.0 | MIT | [version source](https://pypi.org/project/jaraco.functools/4.6.0/#files) |
| keyring | 25.6.0 | MIT | [version source](https://pypi.org/project/keyring/25.6.0/#files) |
| lz4 | 4.4.5 | BSD-3-Clause | [version source](https://pypi.org/project/lz4/4.4.5/#files) |
| macholib | 1.16.4 | MIT | [version source](https://pypi.org/project/macholib/1.16.4/#files) |
| more-itertools | 11.1.0 | MIT | [version source](https://pypi.org/project/more-itertools/11.1.0/#files) |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause | [version source](https://pypi.org/project/packaging/26.3/#files) |
| pip | 26.2.1 | MIT | [version source](https://pypi.org/project/pip/26.2.1/#files) |
| pyinstaller | 6.16.0 | GPL-2.0-or-later with bundling exception; selected files Apache-2.0 | [version source](https://pypi.org/project/pyinstaller/6.16.0/#files) |
| pyinstaller-hooks-contrib | 2026.7 | Apache-2.0 / GPL-2.0 (file-specific; review hooks exception) | [version source](https://pypi.org/project/pyinstaller-hooks-contrib/2026.7/#files) |
| setuptools | 84.0.0 | MIT | [version source](https://pypi.org/project/setuptools/84.0.0/#files) |

## 번들 글꼴

앱 화면에 포함되는 글꼴 파일입니다. 라이선스 원문은 `public/fonts/Pretendard-OFL.txt`이며 앱의 오픈소스 라이선스 목록(`public/licenses/THIRD_PARTY_LICENSES.txt`)에도 같은 원문이 들어 있습니다.

| Font | Version | License metadata | Source |
| --- | --- | --- | --- |
| Pretendard Variable (`PretendardVariable.woff2`) | 1.3.9 | OFL-1.1 (Copyright (c) 2021 Kil Hyung-jin, Reserved Font Name Pretendard) | [orioncactus/pretendard](https://github.com/orioncactus/pretendard) |

`src/components/Brand.svelte`의 로고 글자는 Pretendard 글리프에서 만든 윤곽선 경로이며 OFL이 허용하는 파생입니다. 글꼴 파일 자체를 다른 이름으로 배포하지 않습니다.
