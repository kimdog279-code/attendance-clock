// 대시보드 프론트엔드 (외부 라이브러리 없음)
const $ = (sel) => document.querySelector(sel);
const won = (n) => Number(n).toLocaleString("ko-KR");
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let currentCode = "005930";
let chartData = [];
let engineTimer = null;
let MODE = "paper";
let setupTarget = "paper";

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "요청 실패");
  return data;
}

// ── 초기화 ─────────────────────────────────────────────────────
function renderModeSwitch() {
  $("#mwPaper").className = MODE === "paper" ? "on paper-on" : "";
  $("#mwReal").className = MODE === "real" ? "on real-on" : "";
}

function showSetupForm(target, canGoBack) {
  setupTarget = target;
  $("#setupTitle").textContent = target === "real" ? "⚠ 실전투자 키 등록" : "처음 설정";
  $("#setupNotice").innerHTML =
    target === "real"
      ? "KIS Developers 포털에서 발급받은 <b>실전투자용</b> 키를 입력하세요 (모의투자 키와 별개). " +
        "등록해도 <b>주문은 안전장치를 켜기 전까지 차단</b>되며, 조회만 가능합니다. " +
        "계좌번호는 실제 위탁계좌 8자리입니다."
      : "KIS Developers 포털에서 발급받은 <b>모의투자용</b> 키를 입력하세요. 키는 내 컴퓨터의 config.json 파일에만 저장됩니다.";
  $("#labAccount").textContent =
    target === "real" ? "실전 계좌번호 (실제 위탁계좌, 숫자 8자리)" : "모의투자 계좌번호 (숫자 8자리)";
  $("#btnBackToPaper").classList.toggle("hidden", !canGoBack);
  $("#setup").classList.remove("hidden");
}

async function init() {
  const st = await api("/api/status");
  $("#version").textContent = "v" + st.version;
  MODE = st.mode;
  renderModeSwitch();

  if (!st.configured) {
    showSetupForm(st.mode, st.mode === "real" && st.profiles.paper);
    return;
  }

  $("#dash").classList.remove("hidden");

  // 실전 모드 전용 UI
  $("#safetyCard").classList.toggle("hidden", MODE !== "real");
  if (MODE === "real") {
    $("#setAllow").checked = st.settings.allowRealOrders;
    $("#setAllowAuto").checked = st.settings.allowRealAutoTrade;
    $("#setMax").value = st.settings.maxOrderAmount;
    $("#setLossLimit").value = st.settings.dailyLossLimit;
    $("#setMaxOrders").value = st.settings.maxDailyOrders;

    const liveRadio = document.querySelector('input[name="engMode"][value="live"]');
    const liveLabel = liveRadio.closest("label");
    const unlocked = st.settings.allowRealOrders && st.settings.allowRealAutoTrade;
    if (unlocked) {
      liveLabel.innerHTML = '<input type="radio" name="engMode" value="live" /> 자동 주문 (🚨 실전 — 진짜 돈)';
    } else {
      liveRadio.disabled = true;
      liveLabel.style.opacity = "0.55";
      liveLabel.innerHTML =
        '<input type="radio" name="engMode" value="live" disabled /> 자동 주문 🔒 — 아래 [⚠ 실전 안전장치]에서 두 허용 스위치를 켜면 열립니다';
    }
  }

  refreshAll();
  loadStrategyCatalog().catch(() => {});
  loadWatchlist();
  loadMobile();
  syncEngine(st.engine);
  checkUpdate();
  setInterval(() => loadPrice().catch(() => {}), 15000);
}

// ── 전략 목록 채우기 ───────────────────────────────────────────
async function loadStrategyCatalog() {
  const catalog = await api("/api/strategies");
  const optionHtml = catalog
    .map(
      (s) =>
        `<optgroup label="${s.name}">` +
        s.options.map((o) => `<option value='${JSON.stringify({ id: s.id, params: o.params })}'>${o.label}</option>`).join("") +
        "</optgroup>"
    )
    .join("");
  $("#btStrategy").innerHTML =
    `<option value="custom">이동평균 크로스 — 기간 직접 입력</option>` + optionHtml;
  $("#engStrategySel").innerHTML = optionHtml;
  $("#btStrategy").addEventListener("change", () => {
    $("#smaParams").style.display = $("#btStrategy").value === "custom" ? "" : "none";
  });
}

// 자동매매 카드의 전략 선택값 읽기
function selectedEngineStrategy() {
  const sel = $("#engStrategySel");
  const opt = sel.selectedOptions[0];
  try {
    return { ...JSON.parse(sel.value), label: opt ? opt.textContent : "" };
  } catch {
    return { id: "sma", params: { short: 5, long: 20 }, label: "이동평균 크로스 5/20일" };
  }
}

async function refreshAll() {
  loadPrice().catch((e) => ($("#priceSub").textContent = e.message));
  loadBalance().catch((e) => ($("#balanceBox").textContent = e.message));
  loadChart().catch(() => {});
}

// ── 현재가 ─────────────────────────────────────────────────────
async function loadPrice() {
  const p = await api("/api/price?code=" + currentCode);
  $("#price").textContent = won(p.price);
  const up = p.change >= 0;
  $("#delta").className = "delta " + (up ? "up" : "down");
  $("#delta").textContent = `${up ? "▲" : "▼"} ${won(Math.abs(p.change))} (${up ? "+" : ""}${p.changeRate}%)`;
  $("#priceSub").textContent = `시가 ${won(p.open)} · 고가 ${won(p.high)} · 저가 ${won(p.low)} · 거래량 ${won(p.volume)}`;
}

// ── 계좌 ───────────────────────────────────────────────────────
async function loadBalance() {
  const b = await api("/api/balance");
  let html = "";
  if (b.holdings.length > 0) {
    html += "<table><tr><th>종목</th><th class='num'>수량</th><th class='num'>손익</th></tr>";
    for (const h of b.holdings) {
      const up = h.profitLoss >= 0;
      html += `<tr><td>${h.name}</td><td class="num">${won(h.qty)}</td>
        <td class="num" style="color:var(--${up ? "up" : "down"})">${up ? "+" : ""}${won(h.profitLoss)}원</td></tr>`;
    }
    html += "</table>";
  }
  html += `<div class="subline" style="margin-top:8px">현금 ${won(b.cash)}원 · 총평가 ${won(b.totalEval)}원</div>`;
  $("#balanceBox").innerHTML = html || "보유 종목 없음";
}

// ── 차트 ───────────────────────────────────────────────────────
function smaSeries(closes, n) {
  return closes.map((_, i) => {
    if (i < n - 1) return null;
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += closes[j];
    return sum / n;
  });
}

async function loadChart() {
  const { candles } = await api("/api/chart?code=" + currentCode + "&days=130");
  chartData = candles;
  drawChart();
}

function drawChart() {
  const svg = $("#chart");
  const W = (svg.parentElement.clientWidth || 900);
  const H = 280;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);

  if (chartData.length < 21) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${css("--muted")}" font-size="14">
      데이터가 없습니다 — 위의 [데이터 수집/갱신]을 눌러주세요</text>`;
    $("#legend").innerHTML = "";
    return;
  }

  const M = { l: 58, r: 64, t: 14, b: 26 };
  const closes = chartData.map((c) => c.close);
  const sma5 = smaSeries(closes, 5);
  const sma20 = smaSeries(closes, 20);
  const all = [...closes, ...sma5, ...sma20].filter((v) => v != null);
  const min = Math.min(...all), max = Math.max(...all);
  const pad = (max - min) * 0.06 || 1;
  const y0 = min - pad, y1 = max + pad;

  const X = (i) => M.l + (i / (chartData.length - 1)) * (W - M.l - M.r);
  const Y = (v) => M.t + (1 - (v - y0) / (y1 - y0)) * (H - M.t - M.b);
  const path = (arr) =>
    arr.map((v, i) => (v == null ? "" : `${arr[i - 1] == null ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`)).join("");

  // 눈금 (가로 4줄) + 날짜 라벨 5개
  let g = "";
  for (let k = 0; k <= 4; k++) {
    const v = y0 + ((y1 - y0) * k) / 4;
    const y = Y(v);
    g += `<line x1="${M.l}" x2="${W - M.r}" y1="${y}" y2="${y}" stroke="${css("--grid")}" stroke-width="1"/>
          <text x="${M.l - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="${css("--muted")}"
            style="font-variant-numeric:tabular-nums">${won(Math.round(v))}</text>`;
  }
  for (let k = 0; k <= 4; k++) {
    const i = Math.round(((chartData.length - 1) * k) / 4);
    const d = chartData[i].date;
    g += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${css("--muted")}">
      ${d.slice(4, 6)}/${d.slice(6, 8)}</text>`;
  }

  const s1 = css("--series-1"), s2 = css("--series-2"), s3 = css("--series-3");
  const lines = `
    <path d="${path(closes)}" fill="none" stroke="${s1}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${path(sma5)}" fill="none" stroke="${s2}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${path(sma20)}" fill="none" stroke="${s3}" stroke-width="2" stroke-linejoin="round"/>`;

  // 오른쪽 끝 직접 라벨 (색점 + 잉크색 글자, 겹침 방지 정렬)
  const last = chartData.length - 1;
  const ends = [
    { y: Y(closes[last]), color: s1, name: "종가" },
    { y: Y(sma5[last]), color: s2, name: "5일선" },
    { y: Y(sma20[last]), color: s3, name: "20일선" },
  ].sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) {
    if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  }
  const labels = ends
    .map(
      (e) => `<circle cx="${W - M.r + 8}" cy="${e.y}" r="4" fill="${e.color}"/>
      <text x="${W - M.r + 16}" y="${e.y + 4}" font-size="11.5" fill="${css("--ink-2")}">${e.name}</text>`
    )
    .join("");

  svg.innerHTML =
    g + lines + labels +
    `<line id="xhair" y1="${M.t}" y2="${H - M.b}" stroke="${css("--baseline")}" stroke-width="1" visibility="hidden"/>
     <rect id="hit" x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}" fill="transparent"/>`;

  $("#legend").innerHTML = [
    [s1, "종가 (그날의 마지막 가격)"],
    [s2, "5일선 (최근 5일 평균)"],
    [s3, "20일선 (최근 20일 평균)"],
  ].map(([c, t]) => `<span><span class="dot" style="background:${c}"></span>${t}</span>`).join("");

  // 호버 십자선 + 툴팁
  const hit = svg.querySelector("#hit");
  const xhair = svg.querySelector("#xhair");
  const tip = $("#tooltip");
  hit.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(chartData.length - 1, Math.round(((px - M.l) / (W - M.l - M.r)) * (chartData.length - 1))));
    const x = X(i);
    xhair.setAttribute("x1", x);
    xhair.setAttribute("x2", x);
    xhair.setAttribute("visibility", "visible");
    const d = chartData[i].date;
    tip.innerHTML = `<div class="t-date">${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}</div>` +
      [[s1, "종가", closes[i]], [s2, "5일선", sma5[i]], [s3, "20일선", sma20[i]]]
        .filter(([, , v]) => v != null)
        .map(([c, n, v]) => `<div class="t-row"><span class="dot" style="background:${c}"></span>${n}<b>${won(Math.round(v))}</b></div>`)
        .join("");
    tip.style.display = "block";
    const wrapW = $("#chartWrap").clientWidth;
    const left = (x / W) * wrapW;
    tip.style.left = Math.min(left + 14, wrapW - 150) + "px";
    tip.style.top = "20px";
  });
  hit.addEventListener("mouseleave", () => {
    tip.style.display = "none";
    xhair.setAttribute("visibility", "hidden");
  });
}

// ── 데이터 수집 ────────────────────────────────────────────────
$("#btnCollect").addEventListener("click", async () => {
  const btn = $("#btnCollect");
  btn.disabled = true;
  $("#chartMsg").className = "msg";
  $("#chartMsg").textContent = "수집 중... 처음이면 1~2분 걸립니다. 잠시만요.";
  try {
    const r = await api("/api/collect", { method: "POST", body: { code: currentCode } });
    $("#chartMsg").className = "msg ok";
    $("#chartMsg").textContent = `완료! 총 ${won(r.total)}일치 데이터가 저장됐습니다.`;
    await loadChart();
  } catch (e) {
    $("#chartMsg").className = "msg err";
    $("#chartMsg").textContent = e.message;
  }
  btn.disabled = false;
});

// ── 백테스트 ───────────────────────────────────────────────────
$("#btnBacktest").addEventListener("click", async () => {
  const el = $("#btResult");
  el.innerHTML = "계산 중...";
  try {
    const sel = $("#btStrategy").value;
    let qs;
    if (sel === "custom" || sel === "") {
      qs = `strategy=sma&short=${$("#inShort").value}&long=${$("#inLong").value}`;
    } else {
      const { id, params } = JSON.parse(sel);
      qs = `strategy=${id}&params=${encodeURIComponent(JSON.stringify(params))}`;
    }
    const r = await api(`/api/backtest?code=${currentCode}&${qs}`);
    const pct = (x) => (x * 100).toFixed(1) + "%";
    const cls = (x) => (x >= 0 ? "var(--up)" : "var(--down)");
    el.innerHTML = `
      ${r.label ? `<div class="hint" style="margin-bottom:8px">전략: <b>${r.label}</b></div>` : ""}
      <div class="stats">
        <div class="stat"><div class="k">이 전략을 썼다면</div><div class="v" style="color:${cls(r.totalReturn)}">${pct(r.totalReturn)}</div></div>
        <div class="stat"><div class="k">그냥 사서 보유했다면</div><div class="v" style="color:${cls(r.buyHoldReturn)}">${pct(r.buyHoldReturn)}</div></div>
        <div class="stat"><div class="k">중간 최대 하락폭</div><div class="v">${pct(r.maxDrawdown)}</div></div>
        <div class="stat"><div class="k">매매 횟수 · 승률</div><div class="v">${r.tradeCount}회 · ${r.winRate == null ? "-" : pct(r.winRate)}</div></div>
      </div>
      <div class="hint" style="margin-top:8px">기간 ${r.period} · 1,000만원 → ${won(r.finalEquity)}원 · 과거 성과가 미래를 보장하지 않습니다</div>`;
  } catch (e) {
    el.innerHTML = `<span class="msg err">${e.message}</span>`;
  }
});

// ── 주문 ───────────────────────────────────────────────────────
async function placeOrder(side) {
  const qty = Number($("#inQty").value);
  const label = side === "buy" ? "매수" : "매도";
  const priceNow = $("#price").textContent;
  const stockLabel = $("#stockName").textContent || currentCode;
  const message =
    MODE === "real"
      ? `⚠⚠ 실전 계좌 — 진짜 돈입니다 ⚠⚠\n\n${stockLabel}(${currentCode}) ${qty}주 시장가 ${label}\n현재가 기준 약 ${priceNow}원 × ${qty}주\n\n정말 주문할까요?`
      : `${stockLabel}(${currentCode}) ${qty}주를 시장가로 ${label}할까요?\n(모의투자 · 현재가 기준 약 ${priceNow}원 × ${qty}주)`;
  if (!confirm(message)) return;
  const msg = $("#orderMsg");
  msg.className = "msg";
  msg.textContent = "주문 넣는 중...";
  try {
    const r = await api("/api/order", { method: "POST", body: { side, code: currentCode, qty } });
    msg.className = "msg ok";
    msg.textContent = `✅ 주문 접수! (주문번호 ${r.orderNo}) — 장 시간이 아니면 다음 개장 때 처리됩니다`;
    setTimeout(() => loadBalance().catch(() => {}), 2500);
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = e.message;
  }
}
$("#btnBuy").addEventListener("click", () => placeOrder("buy"));
$("#btnSell").addEventListener("click", () => placeOrder("sell"));
$("#btnBalance").addEventListener("click", () => loadBalance().catch(() => {}));

// ── 전략 추천 ──────────────────────────────────────────────────
$("#btnRecommend").addEventListener("click", async () => {
  const el = $("#recResult");
  el.innerHTML = "분석 중... (전략 4종 × 여러 설정을 전부 시뮬레이션합니다)";
  try {
    const r = await api("/api/recommend?code=" + currentCode);
    const pct = (x) => (x * 100).toFixed(1) + "%";
    const rec = r.recommendation;
    const holdWins = r.verdict === "hold";
    const col = (x) => (x >= 0 ? "var(--up)" : "var(--down)");
    const trophy = (won) => (won ? "🏆 " : "");
    const bhRow = `<tr>
      <td>${trophy(holdWins)}단순 보유 (사서 안 팔기)</td>
      <td class="num" style="color:${col(r.buyHoldValidate.totalReturn)}">${pct(r.buyHoldValidate.totalReturn)}</td>
      <td class="num">${pct(r.buyHoldValidate.maxDrawdown)}</td>
      <td class="num">-</td></tr>`;
    const rows = r.finalists
      .map(
        (f, i) => `<tr>
          <td>${trophy(!holdWins && i === 0)}${f.label}${f.validate.tradeCount === 0 ? ' <span class="hint">(시험 기간에 신호 없음)</span>' : ""}</td>
          <td class="num" style="color:${col(f.validate.totalReturn)}">${pct(f.validate.totalReturn)}</td>
          <td class="num">${pct(f.validate.maxDrawdown)}</td>
          <td class="num">${f.validate.tradeCount}회</td></tr>`
      )
      .join("");
    const headline = holdWins
      ? `<b>결론: 이 종목은 "사서 들고 있기"가 가장 나았습니다</b><br/>
         시험 기간(최근 1년) 보유 수익률 <b style="color:${col(r.buyHoldValidate.totalReturn)}">${pct(r.buyHoldValidate.totalReturn)}</b>
         — 어떤 타이밍 전략도 이걸 이기지 못했어요.
         타이밍 매매를 원하면 표에서 전략을 고를 수 있지만, 이 종목에서는 근거가 약합니다.`
      : `<b>추천: ${rec.label}</b><br/>
         시험 기간(최근 1년) 수익률 <b style="color:${col(rec.validate.totalReturn)}">${pct(rec.validate.totalReturn)}</b>
         (그냥 보유했다면 ${pct(r.buyHoldValidate.totalReturn)})
         · 최대 하락폭 ${pct(rec.validate.maxDrawdown)} · 매매 ${rec.validate.tradeCount}회`;
    el.innerHTML = `
      <div class="notice" style="margin-bottom:12px">${headline}</div>
      <table>
        <tr><th>비교 (시험 기간 성적)</th><th class="num">시험 수익률</th><th class="num">최대 하락폭</th><th class="num">매매</th></tr>
        ${bhRow}
        ${rows}
      </table>
      <div class="row" style="margin-top:10px">
        ${holdWins ? "" : '<button class="small" id="btnUseRec">이 전략을 자동매매에 적용</button>'}
        <span class="hint">연습 ${r.period.train} → 시험 ${r.period.validate} · 총 ${r.candidatesTried}개 조합 비교 · 과거 성과일 뿐 미래 보장이 아닙니다</span>
      </div>`;
    if (holdWins) return;
    $("#btnUseRec").addEventListener("click", () => {
      const sel = $("#engStrategySel");
      const want = JSON.stringify({ id: rec.id, params: rec.params });
      for (const opt of sel.options) {
        if (opt.value === want) {
          sel.value = want;
          break;
        }
      }
      sel.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  } catch (e) {
    el.innerHTML = `<span class="msg err">${e.message}</span>`;
  }
});

// ── 자동매매 ───────────────────────────────────────────────────
function engineName(code) {
  return (
    watch.favorites.find((f) => f.code === code)?.name ||
    watch.recent.find((r) => r.code === code)?.name ||
    KNOWN_NAMES[code] ||
    code
  );
}

function syncEngine(st) {
  const logEl = $("#engineLog");
  const list = $("#engineList");
  const runningEngines = st.engines.filter((e) => e.running);

  list.innerHTML = runningEngines
    .map(
      (e) => `<div class="eng-row">
        <span class="pulse"></span>
        <span class="who">${engineName(e.code)} <span class="hint">${e.code}</span></span>
        <span class="what">${e.strategyLabel ?? ""}</span>
        <span class="tag ${e.live ? "live" : "practice"}">${e.live ? (MODE === "real" ? "🚨 실전 주문" : "모의 주문") : "연습"}</span>
        ${e.position ? '<span class="hint">보유 중</span>' : ""}
        <button class="small ghost" data-stop="${e.code}">정지</button>
      </div>`
    )
    .join("");
  list.querySelectorAll("[data-stop]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api("/api/engine/stop", { method: "POST", body: { code: b.dataset.stop } });
      setTimeout(async () => syncEngine(await api("/api/engine")), 600);
    })
  );

  $("#engineDot").classList.toggle("hidden", runningEngines.length === 0);
  if (st.logs?.length) {
    logEl.textContent = st.logs.join("\n") + (runningEngines.length === 0 ? "\n(모두 정지됨)" : "");
    logEl.scrollTop = logEl.scrollHeight;
  }

  if (runningEngines.length > 0 && !engineTimer) {
    engineTimer = setInterval(async () => {
      try { syncEngine(await api("/api/engine")); } catch {}
    }, 3000);
  } else if (runningEngines.length === 0 && engineTimer) {
    clearInterval(engineTimer);
    engineTimer = null;
  }
}

$("#btnEngine").addEventListener("click", async () => {
  try {
    const live = document.querySelector('input[name="engMode"]:checked').value === "live";
    const strat = selectedEngineStrategy();
    const liveConfirm =
      MODE === "real"
        ? `🚨 실전 자동매매를 시작합니다 — 진짜 돈입니다!\n전략: ${strat.label}\n종목: ${engineName(currentCode)} (${currentCode})\n\n신호가 오면 사람 확인 없이 실전 계좌에 주문이 나갑니다.\n하루 손실 한도에 도달하면 자동으로 멈춥니다.\n\n시작할까요?`
        : `주문 실행 모드입니다.\n전략: ${strat.label}\n종목: ${engineName(currentCode)} (${currentCode})\n신호가 오면 모의투자 계좌에 진짜 주문이 나갑니다. 시작할까요?`;
    if (live && !confirm(liveConfirm)) return;
    await api("/api/engine/start", {
      method: "POST",
      body: { code: currentCode, live, strategy: { id: strat.id, params: strat.params } },
    });
    setTimeout(async () => syncEngine(await api("/api/engine")), 800);
  } catch (e) {
    $("#engineLog").textContent = e.message;
  }
});

// ── 종목 선택 ──────────────────────────────────────────────────
// 자주 쓰는 종목 이름표 (서버 조회 실패 시의 보조 수단)
const KNOWN_NAMES = {
  "005930": "삼성전자", "000660": "SK하이닉스", "035720": "카카오", "005380": "현대차",
  "035420": "NAVER", "042700": "한미반도체", "007660": "이수페타시스", "009150": "삼성전기",
  "131970": "두산테스나", "267260": "HD현대일렉트릭", "010120": "LS ELECTRIC",
  "298040": "효성중공업", "018260": "삼성SDS", "328130": "루닛", "066570": "한국전자금융",
};

async function showStockName(code) {
  const el = $("#stockName");
  let name = KNOWN_NAMES[code] ?? "";
  el.textContent = name;
  try {
    const r = await api("/api/name?code=" + code);
    if (r.name) name = r.name;
    if (name) el.textContent = name;
    else el.textContent = "이름 확인 불가 — 코드를 다시 확인하세요";
  } catch {}
  return name; // 경고 문구가 아니라 실제 이름(또는 빈 값)만 반환
}

// ── 최근 조회 · 관심종목 ───────────────────────────────────────
let watch = { favorites: [], recent: [] };

function renderChips() {
  const favCodes = new Set(watch.favorites.map((f) => f.code));
  const items = [
    ...watch.favorites.map((f) => ({ ...f, fav: true })),
    ...watch.recent.filter((r) => !favCodes.has(r.code)).slice(0, 6),
  ];
  if (items.length === 0) {
    // 처음 사용 — 시작용 예시 종목
    items.push({ code: "005930", name: "삼성전자" }, { code: "000660", name: "SK하이닉스" });
  }
  $("#chips").innerHTML = items
    .map(
      (it) => `<button class="chip ${it.code === currentCode ? "on" : ""}" data-code="${it.code}" data-name="${it.name ?? ""}">
        ${it.fav ? "★ " : ""}${it.name || it.code}</button>`
    )
    .join("");
  document.querySelectorAll("#chips .chip").forEach((c) =>
    c.addEventListener("click", () => setCode(c.dataset.code, c.dataset.name))
  );
  const isFav = favCodes.has(currentCode);
  $("#btnFav").textContent = isFav ? "★ 관심해제" : "☆ 관심등록";
}

async function loadWatchlist() {
  try {
    watch = await api("/api/watchlist");
    renderChips();
  } catch {}
}

async function recordRecent(code, name) {
  try {
    watch = await api("/api/watchlist", { method: "POST", body: { action: "recent", code, name } });
    renderChips();
  } catch {}
}

$("#btnFav").addEventListener("click", async () => {
  const name = KNOWN_NAMES[currentCode] ?? $("#stockName").textContent.replace(/^이름 확인.*$/, "");
  try {
    watch = await api("/api/watchlist", { method: "POST", body: { action: "favorite", code: currentCode, name } });
    renderChips();
  } catch {}
});

function setCode(code, name) {
  currentCode = code;
  $("#inCode").value = code;
  $("#stockName").textContent = name ?? "";
  renderChips();
  showStockName(code).then((resolved) => recordRecent(code, resolved || name || ""));
  refreshAll();
}
// ── 회사명/코드 검색 ───────────────────────────────────────────
let searchTimer = null;

function hideDrop() {
  $("#searchDrop").classList.add("hidden");
}

function showDropNote(text) {
  const drop = $("#searchDrop");
  drop.innerHTML = `<div class="sd-note">${text}</div>`;
  drop.classList.remove("hidden");
}

async function runSearch(query, { autoPickSingle = false } = {}) {
  showDropNote("검색 중... (처음이면 종목 목록을 내려받느라 몇 초 걸립니다)");
  try {
    const { results } = await api("/api/search?q=" + encodeURIComponent(query));
    if (results.length === 0) return showDropNote("검색 결과가 없습니다");
    if (autoPickSingle && results.length === 1) {
      hideDrop();
      return setCode(results[0].code, results[0].name);
    }
    const drop = $("#searchDrop");
    drop.innerHTML = results
      .map((r) => `<div class="sd-item" data-code="${r.code}" data-name="${r.name}">
        <span>${r.name}</span><span class="code">${r.code}</span><span class="mkt">${r.market ?? ""}</span></div>`)
      .join("");
    drop.classList.remove("hidden");
    drop.querySelectorAll(".sd-item").forEach((it) =>
      it.addEventListener("click", () => {
        hideDrop();
        setCode(it.dataset.code, it.dataset.name);
      })
    );
  } catch (e) {
    showDropNote("검색 실패: " + e.message);
  }
}

function submitCodeInput() {
  const v = $("#inCode").value.trim();
  if (/^\d{6}$/.test(v)) {
    hideDrop();
    setCode(v);
  } else if (v.length >= 1) {
    runSearch(v, { autoPickSingle: true });
  }
}

$("#btnGo").addEventListener("click", submitCodeInput);
$("#inCode").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitCodeInput();
  if (e.key === "Escape") hideDrop();
});
$("#inCode").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const v = $("#inCode").value.trim();
  if (/^\d+$/.test(v) || v.length < 2) return hideDrop();
  searchTimer = setTimeout(() => runSearch(v), 350);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".stockbar")) hideDrop();
});

// ── 모드 전환 ──────────────────────────────────────────────────
async function switchMode(want) {
  if (want === MODE) return;
  if (want === "real" && !confirm("실전투자 모드로 전환합니다.\n조회는 자유롭지만, 주문은 [실전 안전장치]에서 허용을 켜기 전까지 차단됩니다.\n계속할까요?")) return;
  try {
    const r = await api("/api/mode", { method: "POST", body: { mode: want } });
    if (r.needsKeys) {
      $("#dash").classList.add("hidden");
      showSetupForm("real", true);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    location.reload();
  } catch (e) {
    alert(e.message);
  }
}
$("#mwPaper").addEventListener("click", () => switchMode("paper"));
$("#mwReal").addEventListener("click", () => switchMode("real"));
$("#btnBackToPaper").addEventListener("click", async () => {
  try {
    await api("/api/mode", { method: "POST", body: { mode: "paper" } });
    location.reload();
  } catch (e) {
    alert(e.message);
  }
});

// ── 실전 안전장치 ──────────────────────────────────────────────
$("#btnSaveSafety").addEventListener("click", async () => {
  const msg = $("#safetyMsg");
  const allow = $("#setAllow").checked;
  const allowAuto = $("#setAllowAuto").checked;
  if (allow && !confirm("⚠ 실전 주문 허용을 켭니다.\n이제 매수/매도 버튼이 진짜 돈으로 주문을 냅니다.\n(1건당 상한과 확인창은 계속 적용됩니다)\n켤까요?")) {
    $("#setAllow").checked = false;
    return;
  }
  if (allowAuto && !confirm(
    "🚨🚨 실전 자동매매를 허용합니다 🚨🚨\n\n" +
    "자동매매를 '자동 주문'으로 시작하면, 프로그램이 사람 확인 없이\n" +
    "실전 계좌에 매수·매도 주문을 냅니다.\n\n" +
    "적용되는 안전장치:\n" +
    `· 매수 1회 예산: 자동매매 예산과 1건 상한 중 작은 금액\n` +
    `· 하루 손실 한도 초과 시 그날 자동 정지\n` +
    `· 하루 주문 횟수 제한\n\n정말 켤까요?`)) {
    $("#setAllowAuto").checked = false;
    return;
  }
  try {
    const r = await api("/api/settings", {
      method: "POST",
      body: {
        allowRealOrders: allow,
        allowRealAutoTrade: allowAuto,
        maxOrderAmount: Number($("#setMax").value),
        dailyLossLimit: Number($("#setLossLimit").value),
        maxDailyOrders: Number($("#setMaxOrders").value),
      },
    });
    msg.className = "msg ok";
    msg.textContent =
      `저장됨 — 주문 ${r.allowRealOrders ? "허용" : "차단"} · 자동매매 ${r.allowRealAutoTrade ? "허용" : "차단"} · ` +
      `1건 상한 ${r.maxOrderAmount === 0 ? "없음" : Number(r.maxOrderAmount).toLocaleString("ko-KR") + "원"} · ` +
      `하루 한도 -${Number(r.dailyLossLimit).toLocaleString("ko-KR")}원/${r.maxDailyOrders}회 — 새로고침하면 자동매매 카드에 반영됩니다`;
    setTimeout(() => location.reload(), 2500);
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = e.message;
  }
});

// ── 설정 ───────────────────────────────────────────────────────
$("#btnSetup").addEventListener("click", async () => {
  const msg = $("#setupMsg");
  msg.className = "msg";
  msg.textContent = "저장하고 접속 테스트 중...";
  $("#btnSetup").disabled = true;
  try {
    const r = await api("/api/setup", {
      method: "POST",
      body: { target: setupTarget, appKey: $("#inKey").value, appSecret: $("#inSecret").value, accountNo: $("#inAccount").value },
    });
    msg.className = "msg ok";
    msg.textContent = `✅ 연결 성공! 삼성전자 현재가 ${won(r.samplePrice)}원 — 화면을 새로 불러옵니다.`;
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    msg.className = "msg err";
    msg.textContent =
      "❌ " + e.message +
      (setupTarget === "real"
        ? " — 포털 신청현황에서 '실전투자' 행의 키인지(모의투자 키 아님), 실전 API 신청이 승인됐는지 확인해주세요."
        : " — 키가 모의투자용이 맞는지 확인해주세요.");
    $("#btnSetup").disabled = false;
  }
});

// ── 핸드폰 접속 ────────────────────────────────────────────────
function renderMobile(m) {
  const btn = $("#btnMobile");
  const info = $("#mobileInfo");
  btn.textContent = m.enabled ? "끄기" : "켜기";
  if (!m.enabled) {
    info.innerHTML =
      "같은 와이파이에 연결된 핸드폰으로 이 프로그램을 보고 조작할 수 있게 합니다. " +
      "PIN 번호를 입력해야 접속되며, 집 밖(LTE/5G)에서는 접속되지 않습니다.";
  } else if (!m.listeningLan) {
    info.innerHTML =
      "⚠ 켜졌습니다 — <b>프로그램을 껐다가 다시 켜면 적용됩니다.</b> " +
      "재시작 후 Windows 방화벽 창이 뜨면 <b>[액세스 허용]</b>을 눌러주세요.";
  } else {
    info.innerHTML =
      `핸드폰 브라우저(같은 와이파이)에서 접속: ` +
      m.urls.map((u) => `<b>${u}</b>`).join(" 또는 ") +
      ` · PIN: <b style="font-size:16px;letter-spacing:2px">${m.pin}</b>` +
      `<br/>접속이 안 되면: 핸드폰이 같은 와이파이인지, 방화벽에서 Node.js를 허용했는지 확인하세요.`;
  }
}

async function loadMobile() {
  try { renderMobile(await api("/api/mobile")); } catch {}
}

$("#btnMobile").addEventListener("click", async () => {
  const turningOn = $("#btnMobile").textContent === "켜기";
  if (turningOn && !confirm(
    "핸드폰 접속을 켭니다.\n\n" +
    "· 같은 와이파이의 기기만 접속 가능하며 PIN 잠금이 걸립니다\n" +
    "· 적용하려면 프로그램을 껐다가 다시 켜야 합니다\n" +
    "· 재시작 시 Windows 방화벽 창이 뜨면 [액세스 허용]을 누르세요\n\n켤까요?")) return;
  try {
    renderMobile(await api("/api/mobile", { method: "POST", body: { enabled: turningOn } }));
  } catch (e) {
    $("#mobileInfo").textContent = e.message;
  }
});

// ── 업데이트 ───────────────────────────────────────────────────
async function checkUpdate() {
  try {
    const u = await api("/api/update");
    if (u.remote) $("#updateBar").style.display = "flex";
  } catch {}
}
$("#btnUpdate").addEventListener("click", async () => {
  $("#updateMsg").textContent = "내려받는 중...";
  try {
    const r = await api("/api/update/apply", { method: "POST" });
    $("#updateMsg").textContent = `완료 (${r.updated}개 파일)! 검은 창을 닫고 시작하기.bat을 다시 더블클릭해주세요.`;
  } catch (e) {
    $("#updateMsg").textContent = "실패: " + e.message;
  }
});

window.addEventListener("resize", () => { if (chartData.length) drawChart(); });
setCode("005930", "삼성전자");
init().catch((e) => alert("서버와 연결할 수 없습니다: " + e.message));
