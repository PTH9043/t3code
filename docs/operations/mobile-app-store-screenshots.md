# 모바일 앱스토어 스크린샷 하네스

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

스크린샷 하네스는 일회용 로컬 T3 환경 세 개를 상대로 실제 모바일 애플리케이션을 실행합니다. 환경마다 격리된
기준 디렉터리와 서버, 결정적인 내용을 담은 실제 Git 프로젝트, 시드로 채운 오케스트레이션 프로젝션, 영속화된
터미널 기록을 만듭니다. 앱은 평소의 연결 흐름으로 모든 서버와 페어링하고, React Navigation이 배포용 Home,
Thread, ThreadTerminal, ThreadReview, SettingsEnvironments 라우트를 엽니다.

애플리케이션 UI를 다시 만들어 내는 스크린샷 전용 화면은 없습니다. `EXPO_PUBLIC_SHOWCASE=1`은 렌더링하지
않는 페어링/준비 상태 조정기를 켜고, 캡처에 소프트웨어 키보드가 담기지 않도록 터미널 자동 포커스를 끄며, 실제
환경 화면에 결정적인 T3 Connect 검색 행을 공급할 뿐입니다. 로컬 환경 카드는 언제나 실제로 페어링된 서버에서
옵니다.

## 기본 매트릭스 캡처

저장소 루트에서 다음을 실행합니다.

    pnpm screenshots:mobile

이 명령은 다음을 수행합니다.

1. 임시 T3 기준 디렉터리 세 개를 만들고, 각각에 대해 사용 가능한 포트에서 로컬 서버를 시작합니다.
2. 알아보기 쉬운 파비콘, 기능 브랜치, 결정적인 T3 Code 리뷰 diff를 갖춘 T3 Code·React·Linux Git 저장소를
   만듭니다.
3. 마이그레이션이 끝난 각 서버의 SQLite 데이터베이스에 재미있는 대화, 메시지, 활동, 터미널 기록을 시드로
   채운 뒤, 전송을 기다리는 영속화된 모바일 발신함 작업 두 개를 추가합니다.
4. 격리된 Metro 서버를 시작하고, 선택한 네이티브 앱을 빌드한 뒤, 각 기기를 부팅합니다.
5. 새로 설치한 각 앱을 Moonbase Terminal, Suspense Station, Kernel Cabin과 페어링합니다.
6. 요청한 모든 장면에 대해 실제 애플리케이션 라우트로 이동합니다.
7. 요청한 시스템 외형을 설정하고 상태 표시줄을 정규화하며, 캡처를 알파 채널 없는 24비트 RGB PNG로 변환하고,
   성공으로 처리하기 전에 크기, 종횡비, 파일 크기, 스크린샷 개수를 검증합니다.
8. App Store Connect나 Google Play Console에 그대로 업로드할 수 있는 스토어 제출용 폴더를
   `artifacts/app-store/screenshots/` 아래에 씁니다.

실행기가 시작한 서버, Metro, 임시 루트 디렉터리, 기기는 캡처가 끝난 뒤 정리됩니다. 확인을 위해 남겨 두려면
`--keep-running`을 전달하세요. 실행기는 기준 디렉터리 경로와 서버 포트를 출력합니다.

캡처는 실제 환경 스냅샷이 채워지고 요청한 라우트가 활성화될 때까지 기다립니다. 두 플랫폼 모두 시뮬레이터/
에뮬레이터 앱 컨테이너에 준비 상태를 기록합니다. 마지막 안정화 대기 시간 덕분에 네이티브 터미널과 Git 리뷰
데이터의 렌더링이 끝날 수 있습니다.

전체 캡처는 빌드에 앞서 Expo의 클린 배포용 prebuild로 선택한 네이티브 프로젝트를 다시 생성합니다. 첫 빌드
이후 반복 캡처에는 --skip-build를 사용하세요.

하네스는 고정된 Metro 포트 `8199`를 사용하는데, 이 포트는 Expo의 일반 기본 포트와는 분리되지만 모든 체크아웃이
공유합니다. 준비 상태 검사는 포트가 열려 있는지만 확인하고 프로세스 소유권은 확인하지 않습니다. 따라서 서로
다른 워크트리에서 스크린샷 하네스를 동시에 실행하면 충돌하거나 엉뚱한 Metro 프로세스에 붙을 수 있습니다.

설정된 모든 기기는 기본적으로 다크 외형을 사용하므로, 옵션 없이 `pnpm screenshots:mobile`을 실행하면 다크
PNG 30장이 나옵니다. 설정된 외형을 덮어쓰려면 `--appearance light`, `--appearance dark`, `--appearance both`
중 하나를 전달하세요. `both`는 60장을 만듭니다.

기본 매트릭스는 다음과 같습니다.

| 출력 폴더                     | 캡처 대상             | 업로드 크기 | 스토어 슬롯                          |
| ----------------------------- | --------------------- | ----------- | ------------------------------------ |
| `apple/iphone-6.9/dark/`      | iPhone 17 Pro Max     | 1320×2868   | App Store Connect iPhone 6.9인치     |
| `apple/iphone-6.5/dark/`      | 일회용 iPhone 14 Plus | 1284×2778   | App Store Connect iPhone 6.5인치     |
| `apple/ipad-13/dark/`         | iPad Pro 13인치 (M5)  | 2752×2064   | App Store Connect iPad 13인치, 가로  |
| `google-play/phone/dark/`     | 420 dpi Pixel AVD     | 1080×1920   | Google Play 휴대폰, 세로 9:16        |
| `google-play/tablet-7/dark/`  | 너비 600dp Pixel AVD  | 1080×1920   | Google Play 7인치 태블릿, 세로 9:16  |
| `google-play/tablet-10/dark/` | 너비 800dp Pixel AVD  | 1440×2560   | Google Play 10인치 태블릿, 세로 9:16 |

각 대상은 대화, 터미널, 리뷰, 대화 목록, 환경을 캡처합니다. 외형 폴더마다 담기는 스크린샷 다섯 장은 설정된
Apple 제한 1–10장, Google 휴대폰 요구 조건 2–8장, Google 태블릿 권장/슬롯 최소 4장과 최대 8장을 모두
충족합니다.

생성되는 트리는 스토어 업로드 필드에 의도적으로 맞추어져 있습니다.

    artifacts/app-store/screenshots/
    ├── apple/
    │   ├── iphone-6.9/dark/{thread,terminal,review,threads,environments}.png
    │   ├── iphone-6.5/dark/{thread,terminal,review,threads,environments}.png
    │   └── ipad-13/dark/{thread,terminal,review,threads,environments}.png
    └── google-play/
        ├── phone/dark/{thread,terminal,review,threads,environments}.png
        ├── tablet-7/dark/{thread,terminal,review,threads,environments}.png
        └── tablet-10/dark/{thread,terminal,review,threads,environments}.png

라이트 전용 실행은 같은 트리를 `light/` 아래에 씁니다. `--appearance both`는 두 외형 폴더를 모두 씁니다.

시뮬레이터나 AVD 이름, 라이트/다크 외형, iOS 방향, 장면, 출력 디렉터리, 캡처 지연,
Android ABI, 뷰포트를 바꾸려면 [mobile-showcase.config.ts](../../scripts/mobile-showcase.config.ts)를
편집하세요.

## GitHub Actions에서 캡처

GitHub의 Actions 탭에서 `Mobile Showcase Screenshots` 워크플로를 실행하고, `all`, `ios`, `android` 중 하나를
고른 뒤 `light`, `dark`, `both` 중 하나를 선택하세요. 기본 디스패치는 두 외형을 모두 캡처하고 iOS와 Android를
동시에 실행합니다. iPhone과 iPad는 12-vCPU Blacksmith macOS 러너에서, Android 휴대폰과 7인치 태블릿, 10인치
태블릿은 KVM 가속 x86_64 에뮬레이터를 갖춘 16-vCPU Blacksmith Linux 러너에서 캡처됩니다.

모든 작업은 캡처가 실패해도 PNG를 업로드하므로, 부분적으로만 끝난 실행도 진단에 유용합니다. 별도의 검증
단계는 성공을 조건으로 걸어 두어, 캡처가 성공한 경우에만 업로드 전에 실행됩니다. 캡처가 실패하면 `always()`
업로드가 부분 PNG를 다시 검증하지 않고 그대로 게시합니다. 워크플로 실행의 Artifacts 섹션에서
`app-store-connect-screenshots`와 `google-play-screenshots`를 내려받으세요. 아티팩트는 14일 동안 보관됩니다.

워크플로는 로컬 캡처와 동일하게 저장소에 커밋된 기기·장면 매트릭스를 사용합니다. Android는 로컬 Apple Silicon
개발을 위해 기본적으로 ARM64를 유지하며, CI는 디버그 APK가 가속 에뮬레이터와 맞도록
`T3_SHOWCASE_ANDROID_ABI=x86_64`를 설정합니다.

## 빠른 반복

장면이나 기기 하나만 캡처합니다.

    pnpm screenshots:mobile --device iphone-6.9 --scene thread
    pnpm screenshots:mobile --platform android --scene review

설정된 외형을 덮어쓰거나 두 변형을 모두 캡처합니다.

    pnpm screenshots:mobile --appearance light
    pnpm screenshots:mobile --appearance dark
    pnpm screenshots:mobile --appearance both

네이티브 빌드를 재사용하고 일회용 환경을 남겨 둡니다.

    pnpm screenshots:mobile --device ipad-13 --skip-build --keep-running

기본적으로는 스크린샷 실행기가 포트 `8199`에서 Metro를 시작하도록 두세요. Metro를 별도 터미널에서 유지하려면
동일한 쇼케이스 환경과 명시적인 하네스 포트로 시작하세요.

    cd apps/mobile
    APP_VARIANT=development EXPO_PUBLIC_SHOWCASE=1 pnpm exec expo start --dev-client --port 8199

그런 다음 저장소 루트에서 캡처를 실행합니다.

    pnpm screenshots:mobile --skip-build --skip-metro --device iphone-6.9

`pnpm --filter @t3tools/mobile showcase`는 Expo를 일반 포트에서 시작하므로 하네스의 `--skip-metro` 모드와는
호환되지 않습니다.

매트릭스와 플래그를 나열합니다.

    pnpm screenshots:mobile --list

Metro, 서버, 시뮬레이터, 에뮬레이터를 시작하지 않고 기존 파일을 검증합니다.

    pnpm screenshots:mobile --validate-only
    pnpm screenshots:mobile --platform ios --validate-only

## 시드된 환경 조정

- 프로젝트 저장소, 대화 프로젝션, 대화 내용, 터미널 출력 기록, Git 변경 사항:
  [mobile-showcase-environment.ts](../../scripts/mobile-showcase-environment.ts)
- 기기 및 캡처 매트릭스:
  [mobile-showcase.config.ts](../../scripts/mobile-showcase.config.ts)
- 시뮬레이터/에뮬레이터 오케스트레이션:
  [mobile-showcase.ts](../../scripts/mobile-showcase.ts)

픽스처 타임스탬프는 캡처 시작 시점을 기준으로 생성되므로, 서버는 여전히 유효한 현재 데이터를 받으면서도 모든
라우트가 안정적인 상대 시간 라벨을 표시합니다. 동일한 결정적 3환경 구성이 iPhone, iPad, Android 휴대폰,
Android 태블릿 캡처를 모두 담당하며, 반응형 차이는 전적으로 배포용 앱 레이아웃에서 나옵니다.

**대기 중** 행은 배포용 오프라인 발신함을 사용하며 실제 T3 Code와 React 픽스처 프로젝트를 가리킵니다. 쇼케이스
조정은 현재 편집을 위해 열어 둔 작업과 똑같이 그 두 항목을 캡처용으로 발신함에 붙잡아 두므로, 시드된 환경에
다시 연결되더라도 스크린샷을 찍기 전에 항목이 전송되어 사라지는 일은 없습니다.

환경 캡처는 세 로컬 픽스처 전송 경로를 각각 Tailscale HTTPS 호스트명, 헬싱키 VPS 호스트명, Tailnet IPv4 주소로
보여 줍니다. 이 표시 전용 치환 덕분에 카드는 원격 우선으로 유지되고, 그동안 하네스는 임시 서버로의 신뢰할 수
있는 루프백 연결을 그대로 씁니다.

## 로컬 사전 요구 사항

- iOS: Xcode 명령줄 도구, 설정된 시뮬레이터 런타임, 설치된 CocoaPods.
- Android: SDK 해석은 `ANDROID_HOME`을 먼저 확인하고, 다음으로 `ANDROID_SDK_ROOT`를 확인하며, 그다음에는
  macOS에서 `$HOME/Library/Android/sdk`, 다른 플랫폼에서 `$HOME/Android/Sdk`를 기본값으로 사용합니다. 해석된
  SDK는 `adb`와 `emulator`를 제공해야 하고, 설정된 AVD가 존재해야 합니다.

업로드 크기의 기준은 하네스입니다. 하네스가 만든 출력물의 크기를 조정하지 마세요. 스토어 규칙이 바뀌면 해당
대상의 `storeAsset` 사양을 갱신하세요. PNG의 크기가 잘못되었거나, 알파 채널이 있거나, 8비트 RGB가 아니거나,
설정된 파일 크기 제한을 초과하거나, Google Play의 9:16 형태·범위를 위반하거나, 전체 출력 세트가 스토어 최소
장수에 미치지 못하면 캡처는 실패합니다.
