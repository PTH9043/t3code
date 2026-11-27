# Google Drive 무방해 백업 · PC ↔ VPS 교환소 운영 절차서

이 문서는 T3 Code의 스트리밍 암호화 Google Drive 백업(`T3ARC2`/`T3ENC2`), 독립 복원 CLI, 그리고 Linux 헤드리스 VPS와 PC 사이의 안전한 Google Drive 교환소(`exchange/`) 운영 절차를 정리합니다.

---

## 1. 폴더 구조와 절대 규칙

```text
Google Drive (개인 드라이브 · drive.file 최소 스코프)
├── T3-Backup/
│   ├── core/                      # 주간 state.sqlite 읽기 전용 스냅샷 + 코어 설정(.t3enc)
│   ├── projects/<name>/           # Opt-In 선택 프로젝트 + git bundle(.t3enc)
│   ├── userdata/<folder>/         # Opt-In 선택 userdata 증분 백업(.t3enc)
│   ├── archives/                  # 월별 events-YYYYMM.sqlite 신규분 스냅샷(.t3enc)
│   └── exchange/                  # PC ↔ VPS 불변 파일 교환소
│       ├── pc/outbox/             # PC → VPS 시간 단위 세그먼트 (.jsonl.gz + .manifest.json)
│       ├── pc/acks/               # PC가 소비 완료한 세그먼트 마커 (<segmentId>.ack.json)
│       ├── vps/outbox/            # VPS → PC 시간 단위 세그먼트 (.jsonl.gz + .manifest.json)
│       └── vps/acks/              # VPS가 소비 완료한 세그먼트 마커 (<segmentId>.ack.json)
└── T3-Knowledge/                  # 양방향 지식 미러 (재귀 + nextPageToken + Changes API)
```

### 절대 규칙

1. **SQLite 원본 공유 금지**: `.sqlite`, `.sqlite3`, `.db`, `.sqlite-wal`, `.sqlite-shm`, `.sqlite-journal` 파일은 교환소(`exchange/`)와 지식 미러에 절대 배치하지 않습니다(코드 레벨 강제 차단).
2. **Append-only 불변 세그먼트**: 세그먼트 파일명(`<writer>_YYYYMMDDTHH_<uuid6>.jsonl.gz` + `.manifest.json`)은 한 번 올리면 절대 수정·덮어쓰기하지 않습니다.
3. **별도 ACK 마커**: 소비 완료 여부는 원본을 지우거나 고치지 않고 `exchange/<consumer>/acks/<segmentId>.ack.json` 파일로만 기록합니다.
4. **단일 Google Cloud OAuth 앱 공유 (Service Account 금지)**:
   - `drive.file` 스코프는 **동일한 Google Cloud OAuth Client ID**로 생성된 파일만 상호 조회할 수 있습니다.
   - 개인 Google Drive는 Service Account에 저장 용량을 할당하지 않으므로 반드시 본인 Google 계정의 OAuth2 데스크톱 클라이언트를 PC와 VPS가 함께 사용합니다.

---

## 2. Google Cloud OAuth 앱 Production 게시 (7일 만료 방지 필수)

OAuth 동의 화면이 **Testing** 상태이면 Google 정책상 Refresh Token이 **7일마다 자동 만료(`invalid_grant`)**되어 자동 백업과 VPS 업로더가 멈춥니다.

1. [Google Cloud Console](https://console.cloud.google.com/) → **API 및 서비스 → 라이브러리**에서 **Google Drive API**를 사용 설정합니다.
2. **API 및 서비스 → OAuth 동의 화면(Google Auth Platform → 대상/Audience)**으로 이동합니다.
3. **앱 게시(Publish App)**를 눌러 게시 상태를 **Testing → Production(프로덕션)**으로 전환합니다.
   - `drive.file`은 비민감(Non-sensitive) 또는 제한 범위로 본인 계정만 사용할 때 Google 경고 화면("확인되지 않은 앱")에서 **고급 → 안전하지 않음(이동)**을 1회 통과하면 만료 없는 Refresh Token을 발급받을 수 있습니다.
4. **사용자 인증 정보 → OAuth 클라이언트 ID 만들기 → 데스크톱 앱**에서 발급된 `Client ID`와 `Client Secret`을 T3 **설정 → Google 계정**에 1회 저장합니다(Windows에서는 DPAPI `CurrentUser` 암호화 저장).

---

## 3. 헤드리스 Linux VPS 인증 및 배포 절차

VPS에는 브라우저가 없으므로 **PC에서 Refresh Token을 확보한 뒤 암호화 봉투(`VPS-TOK1`)로 변환해 `chmod 600`으로 배치**합니다.

### 3.1. 키 파일 생성 및 토큰 암호화 (VPS)

```bash
# 1) 전용 디렉터리 및 32바이트 랜덤 마스터 키 생성 (소유자 전용 0600)
sudo install -d -m 700 -o "$USER" /etc/t3-vps
openssl rand -hex 32 > /etc/t3-vps/token.key
chmod 600 /etc/t3-vps/token.key

# 2) PC에서 받은 동일 OAuth 앱의 Client ID / Secret / Refresh Token을 VPS-TOK1 봉투로 암호화 저장
#    (명령줄 이력에 비밀값이 남지 않도록 임시 JSON 파일 생성 -> init-token -> 원본 즉시 shred/rm 권장)
cat > /tmp/oauth-once.json <<'EOF'
{
  "clientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "clientSecret": "GOCSPX-YOUR_SECRET",
  "refreshToken": "1//YOUR_REFRESH_TOKEN"
}
EOF
chmod 600 /tmp/oauth-once.json

node /opt/t3-vps/scripts/vps-drive-uploader/index.mjs init-token \
  --token-file /etc/t3-vps/drive-token.enc \
  --key-file /etc/t3-vps/token.key \
  --from-json /tmp/oauth-once.json

# 3) 평문 임시 파일 즉시 제거
shred -u /tmp/oauth-once.json 2>/dev/null || rm -f /tmp/oauth-once.json
ls -l /etc/t3-vps/drive-token.enc /etc/t3-vps/token.key
# 두 파일 모두 -rw------- (0600) 확인
```

### 3.2. 시간 단위 세그먼트 업로드 테스트

```bash
node /opt/t3-vps/scripts/vps-drive-uploader/index.mjs upload \
  --token-file /etc/t3-vps/drive-token.enc \
  --key-file /etc/t3-vps/token.key \
  --input-dir /var/lib/t3-vps/outbox-staging \
  --writer vps \
  --drive-root T3-Backup \
  --limit-mbps 10
```

- `EXIT=12`와 `invalid_grant`가 출력되면 OAuth 앱이 Testing 상태이거나 권한이 취소된 것입니다. Production 게시 후 PC에서 Refresh Token을 다시 발급해 `init-token`을 재실행합니다.

### 3.3. `systemd` 시간 단위 타이머 예시

`/etc/systemd/system/t3-vps-drive-upload.service`:

```ini
[Unit]
Description=T3 VPS Hourly Exchange Segment Uploader
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=t3ops
Nice=19
IOSchedulingClass=idle
ExecStart=/usr/bin/node /opt/t3-vps/scripts/vps-drive-uploader/index.mjs upload \
  --token-file /etc/t3-vps/drive-token.enc \
  --key-file /etc/t3-vps/token.key \
  --input-dir /var/lib/t3-vps/outbox-staging \
  --writer vps \
  --drive-root T3-Backup \
  --limit-mbps 10
```

`/etc/systemd/system/t3-vps-drive-upload.timer`:

```ini
[Unit]
Description=Run T3 VPS Exchange Uploader hourly

[Timer]
OnCalendar=hourly
RandomizedDelaySec=120
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now t3-vps-drive-upload.timer
```

---

## 4. 대안: `rclone` (`본인 Client ID` + `crypt` 리모트) 설정 가이드

대용량 파일 묶음이나 기존 운영 도구로 `rclone`을 선호하는 경우, **반드시 본인 OAuth Client ID + `crypt` 암호화 레이어 + 대역폭 제한 + `--ignore-existing`(덮어쓰기 금지)** 조합으로 구성합니다.

### 4.1. `~/.config/rclone/rclone.conf` (`chmod 600` 필수)

```ini
[gdrive_raw]
type = drive
client_id = YOUR_CLIENT_ID.apps.googleusercontent.com
client_secret = GOCSPX-YOUR_SECRET
scope = drive.file
token = {"access_token":"...","token_type":"Bearer","refresh_token":"1//...","expiry":"..."}
chunk_size = 16M
upload_cutoff = 16M

[gdrive_crypt]
type = crypt
remote = gdrive_raw:T3-Backup/rclone-crypt
filename_encryption = standard
directory_name_encryption = true
password = <rclone obscure 생성 암호>
password2 = <rclone obscure 생성 솔트>
```

> 헤드리스 VPS에서 `token` 발급 시 PC에서 `rclone authorize "drive" "<base64_config>"`를 실행해 나온 토큰 JSON을 VPS에 붙여 넣습니다.

### 4.2. 안전한 업로드 명령 (교환소 규칙 준수)

```bash
# 암호화 백업 (대역폭 2.5 MB/s ≈ 20 Mbps, 동시 1전송, 기존 파일 덮어쓰기 금지)
rclone copy /var/lib/t3-vps/segments gdrive_crypt:vps/outbox \
  --ignore-existing \
  --bwlimit 2.5M \
  --drive-chunk-size 16M \
  --transfers 1 \
  --tpslimit 4 \
  --exclude "*.sqlite" \
  --exclude "*.sqlite3" \
  --exclude "*.db" \
  --exclude "*.sqlite-wal" \
  --exclude "*.sqlite-shm"
```

- **주의**: `rclone sync`는 원격 파일을 삭제하거나 덮어쓸 수 있으므로 교환소(`exchange/`)에는 **절대 사용하지 않고 `rclone copy --ignore-existing`만** 사용합니다.

---

## 5. 독립 복원 CLI (`scripts/t3-backup-restore.mjs`) 사용법

T3 서버나 외부 패키지 없이 Node.js 22+만으로 `T3ARC1`/`T3ARC2`/`T3ENC1`/`T3ENC2` 백업을 검사·복원할 수 있습니다.

```bash
# 1) 아카이브 목록·매니페스트 확인
node scripts/t3-backup-restore.mjs inspect path/to/backup.t3enc --passphrase "YOUR_BACKUP_PASSWORD"

# 2) 전체 엔트리 SHA-256 무결성 검증
node scripts/t3-backup-restore.mjs verify path/to/backup.t3enc --passphrase "YOUR_BACKUP_PASSWORD"

# 3) 임시 폴더 복원 + 복원된 .sqlite 파일 자동 PRAGMA quick_check 검증
node scripts/t3-backup-restore.mjs restore path/to/backup.t3enc \
  --out ./restored-check \
  --passphrase "YOUR_BACKUP_PASSWORD"
```

---

## 6. 운영 반영 후 첫 백업 안전 실행 순서

자동 유휴 백업 일정(`autoScheduleEnabled`)의 기본값은 **OFF**입니다. 다음 순서로 검증한 뒤 켜세요.

1. 제어센터 → **구글 드라이브 백업**에서 백업 대상(`userdata` 폴더·프로젝트)을 Opt-In 선택하고 **`미리보기 (Dry-Run)`**으로 크기·파일 수·차단 시크릿을 확인합니다.
2. 암호화 비밀번호를 설정하고 **T3 밖(비밀번호 관리자 등)에 별도 보관**합니다.
3. 유휴 시간에 **`지금 선택 항목 백업`**을 수동 1회 실행해 완료 상태와 WAL 증가량(`walGrowthBytes`)을 확인합니다.
4. **`최근 백업 복구 무결성 검증`**과 `scripts/t3-backup-restore.mjs restore`로 실제 복원·`PRAGMA quick_check` 통과를 확인합니다.
5. 위 1~4 통과 후 **무방해 자동 백업 일정** 토글을 ON으로 전환합니다.
