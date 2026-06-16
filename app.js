// ===== UntilTheEnd — 人生の予算アプリ =====
const MAX_AGE = 100;

// ---- helpers ----
const yen = (n) => Math.round(n).toLocaleString("ja-JP") + "円";
const man = (n) => Math.round(n / 10000).toLocaleString("ja-JP") + "万円";
const num = (id) => {
  const v = parseFloat(String(document.getElementById(id).value).replace(/,/g, ""));
  return isNaN(v) ? 0 : v;
};

// 金額入力欄を 3 桁カンマ区切りに整形（キャレット位置を維持）
function formatMoneyInput(el) {
  const before = el.value;
  const caret = el.selectionStart ?? before.length;
  const digitsBeforeCaret = before.slice(0, caret).replace(/[^0-9]/g, "").length;
  const digits = before.replace(/[^0-9]/g, "");
  if (digits === "") {
    el.value = "";
    return;
  }
  const formatted = Number(digits).toLocaleString("en-US");
  el.value = formatted;
  // キャレットを同じ「桁数目」に復元
  let seen = 0, pos = 0;
  for (; pos < formatted.length; pos++) {
    if (/[0-9]/.test(formatted[pos])) seen++;
    if (seen >= digitsBeforeCaret) { pos++; break; }
  }
  if (digitsBeforeCaret === 0) pos = 0;
  try { el.setSelectionRange(pos, pos); } catch (_) {}
}
// 年利(%) -> 月複利率
const monthlyRate = (annualPct) => Math.pow(1 + annualPct / 100, 1 / 12) - 1;

// ===== 順方向シミュレーション =====
// 任意項目（inflPct / pension / pensionAge）は 0 や未入力なら自動で除外される
function simulate({ age, income, expense, assets, ratePct, inflPct, pension, pensionAge }) {
  const r = monthlyRate(ratePct);
  const infl = (inflPct || 0) / 100;
  const hasPension = pension > 0 && pensionAge > 0;
  let bal = assets;
  const months = [];
  let zeroAge = null;
  let zeroMonth = null;
  const totalMonths = (MAX_AGE - age) * 12;

  for (let m = 0; m < totalMonths; m++) {
    const curAge = age + m / 12;
    const expM = expense * Math.pow(1 + infl, m / 12); // 支出はインフレで増加
    const incM = income + (hasPension && curAge >= pensionAge ? pension : 0); // 受給開始後は年金を加算
    const net = incM - expM;
    bal = bal * (1 + r) + net; // 月初に運用益、月末に収支を反映
    const ageAtMonth = age + Math.floor(m / 12);
    months.push({ m, age: ageAtMonth, income: incM, expense: expM, net, balance: bal });
    if (bal <= 0 && zeroAge === null) {
      zeroAge = age + (m + 1) / 12;
      zeroMonth = m;
      break; // ゼロに到達したら終了
    }
  }

  const finalBalance = months.length ? months[months.length - 1].balance : assets;
  const lasts = zeroAge === null;
  const growing = lasts && finalBalance > assets;

  return { r, months, zeroAge, zeroMonth, finalBalance, lasts, growing, startAge: age, startAssets: assets };
}

// ===== 逆算 =====
// deathAge 時点で targetAssets を残すには、月いくら使えるか（今の物価基準）
// インフレ・年金を将来価値の総和で厳密に解く。任意項目は 0 で自動除外。
function reverseSolve({ age, deathAge, targetAssets, assets, income, ratePct, inflPct, pension, pensionAge }) {
  const r = monthlyRate(ratePct);
  const infl = (inflPct || 0) / 100;
  const hasPension = pension > 0 && pensionAge > 0;
  const N = Math.max(1, Math.round((deathAge - age) * 12));

  // 最終時点(=N ヶ月後)の将来価値で収支を組み立て、基準支出 E について線形に解く
  const growthN = Math.pow(1 + r, N);
  let fvIncome = 0;       // 収入ストリームの将来価値
  let fvExpenseUnit = 0;  // 基準支出 E=1 のときの支出ストリーム将来価値（E の係数）
  for (let m = 0; m < N; m++) {
    const curAge = age + m / 12;
    const incM = income + (hasPension && curAge >= pensionAge ? pension : 0);
    const fvFactor = Math.pow(1 + r, N - 1 - m); // その月の収支がN時点まで複利で増える倍率
    fvIncome += incM * fvFactor;
    fvExpenseUnit += Math.pow(1 + infl, m / 12) * fvFactor;
  }
  const fvAssets = assets * growthN;
  // target = fvAssets + fvIncome - E * fvExpenseUnit
  const expense = (fvAssets + fvIncome - targetAssets) / fvExpenseUnit; // 今の物価での月の使える額
  const net = income - expense; // 受給前・現在時点の月の収支イメージ
  return { r, N, net, expense };
}

// ===== チャート描画(SVG) =====
function renderChart(points, zeroAge) {
  if (points.length < 2) return "";
  const W = 760, H = 320, padL = 64, padR = 18, padT = 18, padB = 38;
  const ages = points.map((p) => p.age);
  const bals = points.map((p) => p.balance);
  const minAge = ages[0], maxAge = ages[ages.length - 1];
  const maxBal = Math.max(...bals, 0);
  const minBal = Math.min(...bals, 0);
  const spanBal = maxBal - minBal || 1;
  const X = (a) => padL + ((a - minAge) / (maxAge - minAge || 1)) * (W - padL - padR);
  const Y = (b) => padT + ((maxBal - b) / spanBal) * (H - padT - padB);

  const line = points.map((p, i) => `${i ? "L" : "M"}${X(p.age).toFixed(1)},${Y(p.balance).toFixed(1)}`).join(" ");
  const area = `${line} L${X(maxAge).toFixed(1)},${Y(0).toFixed(1)} L${X(minAge).toFixed(1)},${Y(0).toFixed(1)} Z`;

  // x軸の目盛り(10歳刻み)
  let xticks = "";
  for (let a = Math.ceil(minAge / 10) * 10; a <= maxAge; a += 10) {
    const x = X(a);
    xticks += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="#eef2f7"/>
      <text x="${x}" y="${H - padB + 18}" text-anchor="middle" fill="#94a3b8" font-size="11">${a}歳</text>`;
  }
  // y軸ラベル
  let yticks = "";
  const yvals = [maxBal, (maxBal + minBal) / 2, minBal];
  yvals.forEach((v) => {
    const y = Y(v);
    yticks += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#f1f5f9"/>
      <text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="#94a3b8" font-size="11">${man(v)}</text>`;
  });
  // ゼロライン
  const zeroLine = `<line x1="${padL}" y1="${Y(0)}" x2="${W - padR}" y2="${Y(0)}" stroke="#cbd5e1" stroke-dasharray="4 4"/>`;
  // ゼロ到達マーカー
  let marker = "";
  if (zeroAge) {
    const x = X(zeroAge);
    marker = `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="#ef4444" stroke-dasharray="3 3"/>
      <circle cx="${x}" cy="${Y(0)}" r="5" fill="#ef4444"/>
      <text x="${x}" y="${padT - 4}" text-anchor="middle" fill="#ef4444" font-size="11" font-weight="700">${zeroAge.toFixed(1)}歳</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="資産推移グラフ">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b82f6" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#3b82f6" stop-opacity="0.02"/>
    </linearGradient></defs>
    ${yticks}${xticks}${zeroLine}
    <path d="${area}" fill="url(#g)"/>
    <path d="${line}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round"/>
    ${marker}
  </svg>`;
}

// ===== テーブル描画 =====
let lastSim = null;
let tableMode = "year";

function buildYearlyRows(sim) {
  const rows = [];
  let accIncome = 0, accExpense = 0;
  sim.months.forEach((mo, i) => {
    accIncome += mo.income;
    accExpense += mo.expense;
    const isYearEnd = (mo.m + 1) % 12 === 0;
    const isLast = i === sim.months.length - 1;
    if (isYearEnd || isLast) {
      rows.push({
        head: `${mo.age}歳`,
        income: accIncome,
        expense: accExpense,
        net: accIncome - accExpense,
        balance: mo.balance,
        zero: mo.balance <= 0,
      });
      accIncome = 0;
      accExpense = 0;
    }
  });
  return rows;
}

function buildMonthlyRows(sim) {
  return sim.months.map((mo) => ({
    head: `${mo.age}歳 / 通算${mo.m + 1}ヶ月`,
    income: mo.income,
    expense: mo.expense,
    net: mo.net,
    balance: mo.balance,
    zero: mo.balance <= 0,
  }));
}

function renderTable() {
  if (!lastSim) return;
  const rows = tableMode === "year" ? buildYearlyRows(lastSim) : buildMonthlyRows(lastSim);
  const colHead = tableMode === "year"
    ? ["年齢", "年間収入", "年間支出", "年間収支", "年末資産"]
    : ["時点", "月収入", "月支出", "月収支", "資産残高"];
  let html = `<table><thead><tr>${colHead.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
  rows.forEach((row) => {
    html += `<tr class="${row.zero ? "zero-row" : ""}">
      <td>${row.head}</td>
      <td>${yen(row.income)}</td>
      <td>${yen(row.expense)}</td>
      <td class="${row.net < 0 ? "neg" : ""}">${row.net >= 0 ? "+" : ""}${yen(row.net)}</td>
      <td class="${row.balance < 0 ? "neg" : ""}">${yen(row.balance)}</td>
    </tr>`;
  });
  html += "</tbody></table>";
  document.getElementById("tableScroll").innerHTML = html;
}

// ===== 順方向: 計算実行 =====
function runForward() {
  const input = {
    age: num("f_age"),
    income: num("f_income"),
    expense: num("f_expense"),
    assets: num("f_assets"),
    ratePct: num("f_rate"),
    inflPct: num("f_infl"),
    pension: num("f_pension"),
    pensionAge: num("f_pensionage"),
  };
  const sim = simulate(input);
  lastSim = sim;

  // 結果ヒーロー
  const hero = document.getElementById("f_hero");
  if (sim.zeroAge !== null) {
    const yearsLeft = sim.zeroAge - input.age;
    hero.className = "result-hero warn";
    hero.innerHTML = `<div class="label">資産が尽きる年齢</div>
      <div class="big">${sim.zeroAge.toFixed(1)} 歳</div>
      <div class="sub">あと約 ${yearsLeft.toFixed(1)} 年（${Math.round(yearsLeft * 12)}ヶ月）でお金がゼロになります</div>`;
  } else {
    hero.className = "result-hero good";
    const trend = sim.growing ? "資産は100歳まで増え続けます 📈" : "100歳まで資産が持ちます";
    hero.innerHTML = `<div class="label">${sim.growing ? "資産は枯渇しません" : "100歳まで安心"}</div>
      <div class="big">${man(sim.finalBalance)}</div>
      <div class="sub">100歳時点の資産（${trend}）</div>`;
  }

  // 統計（現在時点の収支＋有効になっている前提）
  const monthlyNet = input.income - input.expense;
  const pensionTxt = input.pension > 0 && input.pensionAge > 0 ? `${man(input.pension)} / ${input.pensionAge}歳〜` : "なし";
  document.getElementById("f_stats").innerHTML = `
    <div class="stat"><div class="k">月の収支（現在）</div><div class="v ${monthlyNet >= 0 ? "pos" : "neg"}">${monthlyNet >= 0 ? "+" : ""}${yen(monthlyNet)}</div></div>
    <div class="stat"><div class="k">年金</div><div class="v">${pensionTxt}</div></div>
    <div class="stat"><div class="k">利回り / インフレ</div><div class="v">${input.ratePct}% / ${input.inflPct || 0}%</div></div>`;

  // チャート用ポイント(開始点＋年末)
  const points = [{ age: input.age, balance: input.assets }];
  buildYearlyRows(sim).forEach((row) => {
    const a = parseInt(row.head);
    points.push({ age: a + 1, balance: row.balance });
  });
  document.getElementById("f_chart").innerHTML = renderChart(points, sim.zeroAge);

  renderTable();
  document.getElementById("f_output").classList.remove("hidden");
}

// ===== 逆算: 計算実行 =====
function runReverse() {
  const input = {
    age: num("r_age"),
    deathAge: num("r_death"),
    targetAssets: num("r_target"),
    assets: num("r_assets"),
    income: num("r_income"),
    ratePct: num("r_rate"),
    inflPct: num("r_infl"),
    pension: num("r_pension"),
    pensionAge: num("r_pensionage"),
  };
  const res = reverseSolve(input);
  const hero = document.getElementById("r_hero");
  const inflNote = input.inflPct > 0 ? "（今の物価基準）" : "";

  if (res.expense < 0) {
    hero.className = "result-hero warn";
    hero.innerHTML = `<div class="label">この目標には貯蓄が必要です</div>
      <div class="big">不足</div>
      <div class="sub">目標を達成するには、支出ゼロでも月 ${yen(-res.expense)} の追加貯蓄が必要です。収入・利回り・目標額を見直してください。</div>`;
  } else {
    hero.className = "result-hero good";
    hero.innerHTML = `<div class="label">毎月使える金額${inflNote}</div>
      <div class="big">${yen(res.expense)}</div>
      <div class="sub">${input.deathAge}歳で ${man(input.targetAssets)} を残す前提（利回り ${input.ratePct}%／年${input.inflPct > 0 ? `・インフレ ${input.inflPct}%` : ""}）</div>`;
  }

  const pensionTxt = input.pension > 0 && input.pensionAge > 0 ? `${man(input.pension)} / ${input.pensionAge}歳〜` : "なし";
  document.getElementById("r_stats").innerHTML = `
    <div class="stat"><div class="k">月の収入</div><div class="v">${yen(input.income)}</div></div>
    <div class="stat"><div class="k">年金</div><div class="v">${pensionTxt}</div></div>
    <div class="stat"><div class="k">使える期間</div><div class="v">${input.deathAge - input.age}年</div></div>`;

  document.getElementById("r_output").classList.remove("hidden");
}

// ===== UI 配線 =====
document.addEventListener("DOMContentLoaded", () => {
  // タブ
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.target;
      document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
      document.getElementById(target).classList.remove("hidden");
    });
  });

  // ボタン
  document.getElementById("f_run").addEventListener("click", runForward);
  document.getElementById("r_run").addEventListener("click", runReverse);

  // テーブル表示切替
  document.querySelectorAll("#tableToggle button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#tableToggle button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      tableMode = b.dataset.mode;
      renderTable();
    });
  });

  // 金額欄をカンマ区切りに（入力中も整形、初期値も整形）
  document.querySelectorAll("input.money").forEach((el) => {
    formatMoneyInput(el);
    el.addEventListener("input", () => formatMoneyInput(el));
  });

  // 初期計算(サンプル値で結果を表示)
  runForward();
  runReverse();
});
