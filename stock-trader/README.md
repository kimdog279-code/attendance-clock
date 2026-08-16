# stock-trader — 국내 주식 자동매매 프로그램

한국투자증권 **KIS Developers** 오픈 API를 사용하는 국내 주식 자동매매 프로젝트입니다.
외부 라이브러리 없이 Node.js(18+) 내장 `fetch`만 사용합니다.

> ⚠️ 기본 모드는 **모의투자(paper)** 입니다. 실전 계좌 주문은 이중 안전장치
> (`mode: "real"` + `allowRealOrders: true`)를 모두 켜야만 나갑니다.
> 모의투자에서 충분히 검증하기 전에는 절대 실전으로 전환하지 마세요.

## 시작하기 (코딩 전 준비물)

1. **한국투자증권 계좌 개설** — 앱 또는 지점에서 위탁계좌 개설
2. **KIS Developers 앱 키 발급** — <https://apiportal.koreainvestment.com> 접속 → API 신청 → APP Key / APP Secret 발급
3. **모의투자 신청** — 같은 포털에서 모의투자 계좌 신청 (모의투자용 앱 키를 따로 발급받아야 합니다)

## 설치 및 설정

```bash
cd stock-trader
cp config.example.json config.json
# config.json을 열어 앱 키, 시크릿, 계좌번호를 입력
```

| 설정 | 설명 |
|---|---|
| `mode` | `"paper"`(모의투자) 또는 `"real"`(실전). 모의/실전은 **앱 키가 서로 다르니** 모드에 맞는 키를 넣어야 합니다. |
| `accountNo` | `"계좌번호8자리-01"` 형식 |
| `allowRealOrders` | `false`면 실전 모드에서도 주문이 차단됩니다 (조회는 가능) |
| `maxOrderAmount` | 실전 주문 1건당 최대 금액(원). 기본 10만원. `0`이면 상한 없음 (권장하지 않음) |

## 실전 모드로 전환하기

1. KIS Developers 포털에서 **실전투자용** API를 신청해 실전용 APP Key / Secret을 발급받으세요 (모의투자 키와 별개).
2. `config.json`에서 `mode`를 `"real"`로 바꾸고 실전용 키를 입력하세요.
3. 이 상태에서 시세·잔고 **조회**는 자유롭게 됩니다. 주문은 아직 차단 상태입니다.
4. 실제 주문까지 내려면 `allowRealOrders`를 `true`로 바꾸세요. 이때도 1건당 `maxOrderAmount`(기본 10만원)를 넘는 주문은 차단됩니다.

> 자동매매 엔진(5단계)이 완성되기 전까지는 `allowRealOrders`를 켜더라도
> CLI로 직접 내리는 수동 주문만 사용하세요. 검증 안 된 코드에 실전 주문 권한을
> 연결하는 것이 자동매매에서 돈을 잃는 가장 흔한 경로입니다.

`config.json`과 토큰 캐시(`.token-cache.json`)는 `.gitignore`에 등록되어 있어 커밋되지 않습니다. **앱 키를 절대 깃에 올리지 마세요.**

## 사용법

```bash
node src/cli.js price 005930              # 삼성전자 현재가
node src/cli.js daily 005930 20250101     # 일봉 (시작일부터 오늘까지, 최대 100건)
node src/cli.js balance                   # 계좌 잔고·평가손익
node src/cli.js collect 005930 20200101   # 일봉 수집 → data/daily/005930.json
node src/cli.js backtest 005930           # SMA 5/20 크로스 백테스트
node src/cli.js backtest 005930 10 60     # 단기/장기 기간 변경
node src/cli.js buy 005930 1              # 시장가 1주 매수 (모의투자)
node src/cli.js buy 005930 1 60000        # 지정가 매수
node src/cli.js sell 005930 1             # 시장가 매도
```

## 구조

```
src/
  config.js         설정 로드·검증 (모의/실전 분기, 계좌번호 파싱)
  token.js          접근토큰 발급 + 24시간 캐시 (발급 호출 분당 제한 대응)
  kisClient.js      REST 공통 래퍼 (인증 헤더, rt_cd 오류 검사, 모의/실전 tr_id 변환)
  api/
    quotations.js   현재가·일봉 조회
    orders.js       매수/매도 주문 (실전 주문 안전장치 포함)
    balance.js      잔고·평가손익 조회
  store.js          일봉 로컬 저장소 (data/daily/<종목코드>.json, 병합·중복 제거)
  collect.js        일봉 수집기 (100건 제한을 기간 분할 반복 조회로 우회, 호출 제한 대기)
  backtest.js       백테스팅 엔진 (SMA 크로스, 다음 날 시가 체결, 수수료·거래세·MDD)
  cli.js            커맨드라인 진입점
```

## 로드맵

- [x] **1단계 — API 연동 기초**: 토큰 발급/캐시, 현재가·일봉 조회, 잔고 조회, 모의투자 주문
- [x] **2단계 — 데이터 수집**: 일봉 수집기 (`collect`) — 기간 분할 반복 조회, JSON 적재 (분봉이 필요해지면 SQLite로 확장)
- [x] **3단계 — 백테스팅**: SMA 골든/데드크로스 (`backtest`) — 다음 날 시가 체결, 수수료·거래세 반영, 수익률/단순보유 비교/MDD/승률
- [ ] **4단계 — 실시간 시세**: WebSocket(`ops.koreainvestment.com`) 실시간 체결가 수신
- [ ] **5단계 — 자동매매 엔진**: 전략 신호 → 주문 실행, 미체결 관리, 중복 주문 방지, 장 운영시간 처리, 로깅/알림
- [ ] **6단계 — 실전 전환**: 모의투자 수 주 이상 안정 운영 후 소액으로 시작

## 알아둘 것

- **호출 제한**: 실전 초당 20건, 모의투자 초당 2건. 토큰 발급은 분당 1회 수준으로 제한되므로 이 프로젝트는 토큰을 파일에 캐시합니다.
- **모의/실전 tr_id**: 주문·잔고 등 계좌 관련 API는 실전 tr_id(`TTTC...`)의 첫 글자를 `V`로 바꾸면 모의투자용이 됩니다. 시세 조회는 동일합니다.
- **API 명세**: 포털 문서가 수시로 갱신되니, 오류가 나면 [KIS Developers 문서](https://apiportal.koreainvestment.com/apiservice)에서 해당 API의 최신 요청 형식을 확인하세요.
- 백테스트 수익률은 거의 항상 과대평가됩니다. 모의투자 검증 단계를 건너뛰지 마세요.
