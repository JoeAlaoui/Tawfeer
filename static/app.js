/* ===================== STATE ===================== */
let STATE = { categories: [], loans: [], debts: [], transactions: [], months: [] };
let SETTINGS = { currency: "MAD", backupsToKeep: 10, dateFormat: "YYYY-MM-DD", theme: "light", density: "comfortable" };
let ZAKAT = null;
let BUDGET = null;
let BUDGET_HISTORY = [];
let TRASH = [];
let BACKUPS = [];
let allocStrategy = "priority";
let allocSelected = new Set(); // category ids included in the allocator
let firstLoad = true;

async function api(path, opts={}){
  const res = await fetch(path, {
    headers: {"Content-Type":"application/json"},
    ...opts
  });
  if(res.status === 401){
    await showLockScreen();
    throw new Error("locked");
  }
  if(!res.ok){
    const msg = await res.text().catch(()=> "");
    throw new Error(`${res.status} ${msg}`);
  }
  if(res.status === 204) return null;
  return res.json();
}

async function checkAuth(){
  const res = await fetch("/api/auth/status");
  const status = await res.json();
  if(status.pinEnabled && !status.unlocked){
    document.getElementById("lock-screen").style.display = "flex";
    document.getElementById("lock-pin-input").focus();
    return false;
  }
  document.getElementById("lock-screen").style.display = "none";
  return true;
}
async function showLockScreen(){
  document.getElementById("lock-screen").style.display = "flex";
  document.getElementById("lock-pin-input").value = "";
  document.getElementById("lock-pin-input").focus();
}
async function submitUnlock(){
  const pin = document.getElementById("lock-pin-input").value;
  try{
    await fetch("/api/auth/unlock", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({pin})})
      .then(async r=>{ if(!r.ok) throw new Error("wrong"); });
    document.getElementById("lock-error").textContent = "";
    document.getElementById("lock-screen").style.display = "none";
    await refresh();
  }catch(e){
    document.getElementById("lock-error").textContent = "Wrong PIN, try again.";
  }
}
document.getElementById("lock-pin-input").addEventListener("keydown", e=>{ if(e.key==="Enter") submitUnlock(); });

async function refresh(){
  const ok = await checkAuth();
  if(!ok) return;
  if(firstLoad) showSkeletons();
  const [state, settings, zakat, budget, budgetHistory, trash, backups] = await Promise.all([
    api("/api/state"), api("/api/settings"), api("/api/zakat"), api("/api/budget"),
    api("/api/budget/history"), api("/api/trash"), api("/api/backups"),
  ]);
  STATE = state;
  SETTINGS = settings;
  ZAKAT = zakat;
  BUDGET = budget;
  BUDGET_HISTORY = budgetHistory;
  TRASH = trash;
  BACKUPS = backups;
  applyTheme();
  applyDensity();
  if(allocSelected.size === 0){
    STATE.categories.forEach(c=>allocSelected.add(c.id));
  }
  firstLoad = false;
  renderAll();
}
function applyDensity(){
  document.body.classList.toggle("density-compact", SETTINGS.density === "compact");
}

function showSkeletons(){
  const ids = ["dash-cards","cat-cards","debts-cards"];
  ids.forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.innerHTML = Array(3).fill('<div class="skeleton skeleton-card"></div>').join("");
  });
}

function todayStr(){ return new Date().toISOString().slice(0,10); }
function fmt(n){ return Math.round(n).toLocaleString("en-US") + " " + (SETTINGS.currency || "MAD"); }
function formatDate(d){
  if(!d) return "";
  const [y,m,day] = d.split("-");
  if(SETTINGS.dateFormat === "DD/MM/YYYY") return `${day}/${m}/${y}`;
  if(SETTINGS.dateFormat === "MM/DD/YYYY") return `${m}/${day}/${y}`;
  return d;
}

/* ===================== DERIVED HELPERS ===================== */
function categoryBalance(catId){
  return STATE.transactions.filter(t=>t.categoryId===catId).reduce((s,t)=>s+t.amount,0);
}
function categoryDisplayBalance(cat){
  // for recurring goals, progress is measured since the current cycle started, not all-time
  if(cat.recurring && cat.cycleStart){
    return STATE.transactions
      .filter(t=>t.categoryId===cat.id && t.date >= cat.cycleStart)
      .reduce((s,t)=>s+t.amount,0);
  }
  return categoryBalance(cat.id);
}
function totalSaved(){ return STATE.categories.reduce((s,c)=>s+categoryBalance(c.id),0); }
function totalTarget(){ return STATE.categories.reduce((s,c)=>s+c.target,0); }
function loanRemaining(loan){
  const repaid = loan.repayments.reduce((s,r)=>s+r.amount,0);
  return Math.max(0, loan.principal - repaid);
}
function totalLentOutstanding(){ return STATE.loans.filter(l=>l.type==="lent").reduce((s,l)=>s+loanRemaining(l),0); }
function totalBorrowedOutstanding(){ return STATE.loans.filter(l=>l.type==="borrowed").reduce((s,l)=>s+loanRemaining(l),0); }
function totalDebtsRemaining(){ return (STATE.debts||[]).reduce((s,d)=>s+(d.remaining||0),0); }
function netWorth(){ return totalSaved() + totalLentOutstanding() - totalBorrowedOutstanding() - totalDebtsRemaining(); }

/* ---- projection: months left at current pace ---- */
function categoryMonthlyPace(catId){
  const txns = STATE.transactions.filter(t=>t.categoryId===catId && t.amount>0);
  if(txns.length===0) return 0;
  const months = new Set(txns.map(t=>t.month));
  const total = txns.reduce((s,t)=>s+t.amount,0);
  return total / Math.max(1, months.size);
}
function projectionText(cat){
  const bal = categoryBalance(cat.id);
  const remaining = Math.max(0, cat.target - bal);
  if(remaining<=0) return "🎉 Target reached";
  const pace = categoryMonthlyPace(cat.id);
  if(pace<=0) return "No contributions logged yet — can't project";
  const months = Math.ceil(remaining/pace);
  return `~${months} month${months>1?'s':''} left at current pace`;
}

/* ===================== THEME ===================== */
function applyTheme(){
  document.documentElement.setAttribute("data-theme", SETTINGS.theme === "dark" ? "dark" : "light");
  const btn = document.getElementById("theme-toggle");
  if(btn) btn.textContent = SETTINGS.theme === "dark" ? "☀️" : "🌙";
}
async function toggleTheme(){
  SETTINGS.theme = SETTINGS.theme === "dark" ? "light" : "dark";
  applyTheme();
  await api("/api/settings", {method:"PUT", body:JSON.stringify({theme: SETTINGS.theme})});
}
document.getElementById("theme-toggle").addEventListener("click", toggleTheme);

/* ===================== KEYBOARD SHORTCUTS ===================== */
document.addEventListener("keydown", e=>{
  const tag = (e.target.tagName||"").toLowerCase();
  const typing = tag==="input" || tag==="select" || tag==="textarea";
  if(e.key === "Escape"){
    document.querySelectorAll(".modal-bg.open").forEach(m=>m.classList.remove("open"));
    return;
  }
  if(typing) return;
  if(e.key === "/"){
    e.preventDefault();
    const active = document.querySelector(".view.active").id;
    if(active === "view-categories") document.getElementById("txn-search").focus();
    return;
  }
  if(e.key.toLowerCase() === "t"){ toggleTheme(); return; }
  if(e.key.toLowerCase() === "n"){
    const active = document.querySelector(".view.active").id;
    if(active === "view-categories") openCategoryModal();
    else if(active === "view-loans") openLoanModal();
    else if(active === "view-debts") openDebtModal();
    return;
  }
});

/* ===================== NAV ===================== */
document.getElementById("nav").addEventListener("click", e=>{
  const btn = e.target.closest("button[data-view]");
  if(!btn) return;
  document.querySelectorAll("nav button").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  document.getElementById("view-"+btn.dataset.view).classList.add("active");
  renderAll();
});

function showToast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(()=>t.classList.remove("show"), 2200);
}
function showCheckmark(msg){
  let el = document.getElementById("checkmark-overlay");
  if(!el){
    el = document.createElement("div");
    el.id = "checkmark-overlay";
    el.className = "checkmark-overlay";
    document.body.appendChild(el);
  }
  el.innerHTML = `✅ ${msg}`;
  el.classList.add("show");
  setTimeout(()=>el.classList.remove("show"), 1800);
}
function closeModal(id){ document.getElementById(id).classList.remove("open"); }
function openModal(id){ document.getElementById(id).classList.add("open"); }

/* ===================== DASHBOARD ===================== */
function renderDashboard(){
  const kpis = document.getElementById("dash-kpis");
  const saved = totalSaved(), target = totalTarget();
  const pct = target>0 ? Math.round((saved/target)*100) : 0;
  kpis.innerHTML = `
    <div class="kpi"><div class="label">Total Saved</div><div class="value">${fmt(saved)}</div></div>
    <div class="kpi"><div class="label">Total Target</div><div class="value">${fmt(target)}</div></div>
    <div class="kpi"><div class="label">Overall Progress</div><div class="value">${pct}%</div></div>
    <div class="kpi ${netWorth()>=0?'good':'warn'}"><div class="label">Net Worth</div><div class="value">${fmt(netWorth())}</div></div>
    <div class="kpi"><div class="label">Owed to me</div><div class="value">${fmt(totalLentOutstanding())}</div></div>
    <div class="kpi ${totalBorrowedOutstanding()>0?'warn':''}"><div class="label">I owe (loans)</div><div class="value">${fmt(totalBorrowedOutstanding())}</div></div>
    <div class="kpi ${totalDebtsRemaining()>0?'warn':''}"><div class="label">Debts remaining</div><div class="value">${fmt(totalDebtsRemaining())}</div></div>
    <div class="kpi ${ZAKAT && ZAKAT.zakatDueNow>0 ? 'warn':''}"><div class="label">Zakat</div><div class="value" style="font-size:1.1rem;">${ZAKAT ? (ZAKAT.zakatDueNow>0 ? '⚠ Due: '+fmt(ZAKAT.zakatDueNow) : (ZAKAT.aboveNisab?'Above Nisab':'Below Nisab')) : '—'}</div></div>
  `;

  // ---- savings rate + month-over-month comparison ----
  const totals = monthlyNetTotals();
  const curKey = currentMonthKey();
  const prevDate = new Date(); prevDate.setMonth(prevDate.getMonth()-1);
  const prevKey = prevDate.toISOString().slice(0,7);
  const thisMonthNet = totals[curKey] || 0;
  const lastMonthNet = totals[prevKey] || 0;
  let deltaTxt = "—", deltaClass = "";
  if(lastMonthNet !== 0){
    const delta = Math.round(((thisMonthNet - lastMonthNet)/Math.abs(lastMonthNet))*100);
    deltaTxt = `${delta>=0?'+':''}${delta}% vs last month`;
    deltaClass = delta>=0 ? "good" : "warn";
  } else if(thisMonthNet > 0){
    deltaTxt = "First month with savings 🎉";
    deltaClass = "good";
  }
  const income = BUDGET ? (BUDGET.monthlyIncome || 0) : 0;
  const savingsRate = income>0 ? Math.round((thisMonthNet/income)*100) : null;

  document.getElementById("dash-kpis-2").innerHTML = `
    <div class="kpi"><div class="label">This month saved</div><div class="value">${fmt(thisMonthNet)}</div></div>
    <div class="kpi ${deltaClass}"><div class="label">Vs last month</div><div class="value" style="font-size:1.1rem;">${deltaTxt}</div></div>
    <div class="kpi ${savingsRate!==null && savingsRate>=20 ? 'good':''}"><div class="label">Savings rate</div><div class="value">${savingsRate===null?'Set income in Budget':savingsRate+'%'}</div></div>
  `;

  // ---- pinned categories ----
  const pinned = STATE.categories.filter(c=>c.pinned);
  const pinnedPanel = document.getElementById("pinned-panel");
  if(pinned.length){
    pinnedPanel.innerHTML = `<div class="pinned-panel">${pinned.map(c=>{
      const bal = categoryDisplayBalance(c);
      const p = c.target>0 ? Math.min(100, Math.round((bal/c.target)*100)) : 0;
      return `<div class="pinned-card">
        <div class="name">📌 ${c.icon} ${c.name}</div>
        <div class="amount">${fmt(bal)}</div>
        <div class="bar-track" style="margin-top:8px;"><div class="bar-fill" style="width:${p}%"></div></div>
        <div style="font-size:.75rem;margin-top:4px;opacity:.85;">${p}% of ${fmt(c.target)}</div>
      </div>`;
    }).join("")}</div>`;
  } else {
    pinnedPanel.innerHTML = "";
  }

  const cards = document.getElementById("dash-cards");
  const donutSegs = STATE.categories.filter(c=>categoryBalance(c.id)>0).map(c=>({label:`${c.icon} ${c.name}`, value: categoryBalance(c.id)}));
  renderDonutChart("chart-savings-donut", donutSegs, {centerValue: fmt(saved), centerLabel: "Total saved"});
  if(STATE.categories.length===0){
    cards.innerHTML = `<div class="empty-guided" style="grid-column:1/-1;">
      <div class="big">🏡</div>
      <h3>Let's set up your first savings category</h3>
      <p>Categories are things like Emergency Fund, Umrah, or a Car — each with its own target and priority.</p>
      <button class="primary" onclick="goToView('categories');openCategoryModal();">+ Create your first category</button>
    </div>`;
    return;
  }
  cards.innerHTML = [...STATE.categories].sort((a,b)=>a.priority-b.priority).map(c=>{
    const bal = categoryDisplayBalance(c);
    const pct = c.target>0 ? Math.min(100, Math.round((bal/c.target)*100)) : 0;
    const done = bal >= c.target && c.target>0;
    return `<div class="cat-card ${done?'done':''}">
      <div class="top"><div class="name">${c.pinned?'📌 ':''}${c.icon} ${c.name}</div><span class="prio">P${c.priority}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="cat-nums"><span>${fmt(bal)}</span><span>${pct}% of ${fmt(c.target)}</span></div>
      <div class="projection">${projectionText(c)}</div>
    </div>`;
  }).join("");
}

/* ===================== CATEGORIES ===================== */
function deadlineInfoLine(c){
  if(c.recurrenceFrequency === "hijri_event" && c.hijriDisplay){
    const est = c.hijriAvailable === false ? "" : " (estimated)";
    return `<div class="projection">🌙 ${c.hijriDisplay}${est} · ${c.daysRemaining>=0 ? c.daysRemaining+' days left' : 'passed'}${c.amountPerMonth ? ' · '+fmt(c.amountPerMonth)+'/mo needed' : ''}</div>`;
  }
  if(c.resolvedDeadline){
    const overdue = c.daysRemaining !== null && c.daysRemaining < 0;
    return `<div class="projection">📅 Due ${formatDate(c.resolvedDeadline)} · ${overdue ? 'overdue' : c.daysRemaining+' days left'}${c.amountPerMonth ? ' · '+fmt(c.amountPerMonth)+'/mo needed' : ''}</div>`;
  }
  return "";
}
function paceBadge(c){
  if(!c.paceStatus) return "";
  const map = {on_track: ["✅ On track","status-ok"], slightly_behind: ["⚠ Slightly behind","alert-badge"], behind: ["🔴 Behind pace","alert-badge"]};
  const [label, cls] = map[c.paceStatus] || ["",""];
  return label ? `<span class="${cls}" style="margin-left:6px;">${label}</span>` : "";
}
function renderCategories(){
  const wrap = document.getElementById("cat-cards");
  if(STATE.categories.length===0){
    wrap.innerHTML = `<div class="empty-guided" style="grid-column:1/-1;">
      <div class="big">📂</div><h3>No categories yet</h3>
      <p>Create your first savings category to get started.</p>
      <button class="primary" onclick="openCategoryModal()">+ New Category</button>
    </div>`;
  } else {
    wrap.innerHTML = [...STATE.categories].sort((a,b)=>(b.urgencyScore||0)-(a.urgencyScore||0)).map(c=>{
      const bal = categoryDisplayBalance(c);
      const pct = c.target>0 ? Math.min(100, Math.round((bal/c.target)*100)) : 0;
      const done = bal >= c.target && c.target>0;
      const threshold = c.alertThreshold || 90;
      const alertBadge = (pct >= threshold && !done) ? `<span class="alert-badge">🔔 ${threshold}%+</span>` : "";
      const cycleBtn = (c.recurring && done) ? `<button class="mini" onclick="startNewCycle('${c.id}')">🔄 Start new cycle</button>` : "";
      return `<div class="cat-card ${done?'done':''}" draggable="true" data-id="${c.id}">
        <div class="top"><div class="name">${c.pinned?'📌 ':''}${c.icon} ${c.name}${alertBadge}</div><span class="prio" title="${c.priorityLabel||''}">P${c.priority}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="cat-nums"><span>${fmt(bal)} saved</span><span>${fmt(Math.max(0,c.target-bal))} left</span></div>
        <div class="projection">${projectionText(c)}${c.recurring ? ' · 🔁 recurring' : ''}${paceBadge(c)}</div>
        ${deadlineInfoLine(c)}
        <div class="cat-actions">
          <button class="mini" onclick="openMoneyModal('${c.id}','add')">+ Add money</button>
          <button class="mini" onclick="openMoneyModal('${c.id}','remove')">− Withdraw</button>
          <button class="mini" onclick="openCategoryModal('${c.id}')">Edit</button>
          ${cycleBtn}
          <button class="mini danger" onclick="deleteCategory('${c.id}')">Delete</button>
        </div>
      </div>`;
    }).join("");
    wireDragReorder(wrap);
  }
  renderTransactionTable();
}

function renderTransactionTable(){
  const tbody = document.querySelector("#txn-table tbody");
  const q = (document.getElementById("txn-search").value || "").toLowerCase().trim();
  let txns = [...STATE.transactions].sort((a,b)=>b.date.localeCompare(a.date));
  if(q){
    txns = txns.filter(t=>{
      const cat = STATE.categories.find(c=>c.id===t.categoryId);
      const hay = `${t.note||""} ${cat?cat.name:""} ${t.date} ${(t.tags||[]).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }
  txns = txns.slice(0, 50);
  if(txns.length===0){ tbody.innerHTML = `<tr><td colspan="5" class="empty">${q?'No matching transactions.':'No transactions yet.'}</td></tr>`; return; }
  tbody.innerHTML = txns.map(t=>{
    const cat = STATE.categories.find(c=>c.id===t.categoryId);
    const tagChips = (t.tags||[]).map(tag=>`<span class="tag-chip">${tag}</span>`).join("");
    return `<tr>
      <td>${formatDate(t.date)} <span class="month-pill">${t.month}</span></td>
      <td>${cat ? cat.icon+" "+cat.name : "(deleted)"}</td>
      <td class="${t.amount>=0?'pos':'neg'}">${t.amount>=0?'+':''}${fmt(t.amount)}</td>
      <td>${t.note||""} ${tagChips}</td>
      <td>
        <button class="mini" onclick="openEditTransaction('${t.id}')">Edit</button>
        <button class="mini danger" onclick="deleteTransaction('${t.id}')">✕</button>
      </td>
    </tr>`;
  }).join("");
}
document.getElementById("txn-search").addEventListener("input", renderTransactionTable);

/* ---- drag-and-drop priority reorder ---- */
function wireDragReorder(container){
  let dragId = null;
  container.querySelectorAll(".cat-card").forEach(card=>{
    card.addEventListener("dragstart", e=>{ dragId = card.dataset.id; e.dataTransfer.effectAllowed = "move"; });
    card.addEventListener("dragover", e=>{ e.preventDefault(); card.classList.add("drag-over"); });
    card.addEventListener("dragleave", ()=> card.classList.remove("drag-over"));
    card.addEventListener("drop", async e=>{
      e.preventDefault();
      card.classList.remove("drag-over");
      const targetId = card.dataset.id;
      if(!dragId || dragId===targetId) return;
      const a = STATE.categories.find(c=>c.id===dragId);
      const b = STATE.categories.find(c=>c.id===targetId);
      if(!a || !b) return;
      const aPrio = a.priority, bPrio = b.priority;
      await Promise.all([
        api(`/api/categories/${a.id}`, {method:"PUT", body:JSON.stringify({priority: bPrio})}),
        api(`/api/categories/${b.id}`, {method:"PUT", body:JSON.stringify({priority: aPrio})}),
      ]);
      await refresh();
      showToast("Priority updated");
    });
  });
}

function openCategoryModal(id){
  document.getElementById("cat-modal-title").textContent = id ? "Edit Category" : "New Category";
  document.getElementById("cat-id").value = id || "";
  if(id){
    const c = STATE.categories.find(x=>x.id===id);
    document.getElementById("cat-icon").value = c.icon;
    document.getElementById("cat-icon-btn").textContent = c.icon;
    document.getElementById("cat-name").value = c.name;
    document.getElementById("cat-type").value = c.type || "goal";
    document.getElementById("cat-target").value = c.target;
    document.getElementById("cat-priority").value = c.priority;
    document.getElementById("cat-alert-threshold").value = c.alertThreshold ?? 90;
    document.getElementById("cat-deadline").value = c.deadline || "";
    document.getElementById("cat-pinned").checked = !!c.pinned;
    document.getElementById("cat-recurring").checked = !!c.recurring;
    document.getElementById("cat-recurrence-frequency").value = c.recurrenceFrequency || "yearly";
    document.getElementById("cat-hijri-event").value = c.hijriEvent || "eid_al_adha";
  } else {
    document.getElementById("cat-icon").value = "💰";
    document.getElementById("cat-icon-btn").textContent = "💰";
    document.getElementById("cat-name").value = "";
    document.getElementById("cat-type").value = "goal";
    document.getElementById("cat-target").value = "";
    document.getElementById("cat-priority").value = 3;
    document.getElementById("cat-alert-threshold").value = 90;
    document.getElementById("cat-deadline").value = "";
    document.getElementById("cat-pinned").checked = false;
    document.getElementById("cat-recurring").checked = false;
    document.getElementById("cat-recurrence-frequency").value = "yearly";
    document.getElementById("cat-hijri-event").value = "eid_al_adha";
  }
  updateDeadlineHint();
  toggleRecurrenceFields();
  openModal("cat-modal-bg");
}
function toggleRecurrenceFields(){
  const on = document.getElementById("cat-recurring").checked;
  document.getElementById("recurrence-fields").style.display = on ? "block" : "none";
  if(on) toggleHijriEventField();
}
function toggleHijriEventField(){
  const isHijri = document.getElementById("cat-recurrence-frequency").value === "hijri_event";
  document.getElementById("hijri-event-field").style.display = isHijri ? "block" : "none";
  document.getElementById("cat-deadline").disabled = isHijri;
  updateDeadlineHint();
}
function updateDeadlineHint(){
  const hint = document.getElementById("cat-deadline-hint");
  const isHijri = document.getElementById("cat-recurring").checked && document.getElementById("cat-recurrence-frequency").value === "hijri_event";
  hint.textContent = isHijri ? "Deadline is calculated automatically from the Islamic event chosen below." : "";
}
document.getElementById("cat-recurrence-frequency").addEventListener("change", updateDeadlineHint);
async function saveCategory(){
  const id = document.getElementById("cat-id").value;
  const recurring = document.getElementById("cat-recurring").checked;
  const body = {
    icon: document.getElementById("cat-icon").value.trim() || "💰",
    name: document.getElementById("cat-name").value.trim(),
    type: document.getElementById("cat-type").value,
    target: parseFloat(document.getElementById("cat-target").value) || 0,
    priority: Math.min(5, Math.max(1, parseInt(document.getElementById("cat-priority").value) || 3)),
    alertThreshold: parseInt(document.getElementById("cat-alert-threshold").value) || 90,
    deadline: document.getElementById("cat-deadline").value || null,
    pinned: document.getElementById("cat-pinned").checked,
    recurring,
    recurrenceFrequency: recurring ? document.getElementById("cat-recurrence-frequency").value : null,
    hijriEvent: (recurring && document.getElementById("cat-recurrence-frequency").value === "hijri_event")
      ? document.getElementById("cat-hijri-event").value : null,
  };
  if(!body.name){ showToast("Please enter a name"); return; }
  try{
    if(id) await api(`/api/categories/${id}`, {method:"PUT", body:JSON.stringify(body)});
    else await api("/api/categories", {method:"POST", body:JSON.stringify(body)});
    closeModal("cat-modal-bg");
    await refresh();
    showCheckmark("Saved");
  }catch(e){ showToast("Error: "+e.message); }
}
async function startNewCycle(id){
  if(!confirm("Start a new cycle for this recurring goal? Past contributions stay in your history, but progress will track from today.")) return;
  await api(`/api/categories/${id}/new-cycle`, {method:"POST"});
  await refresh();
  showCheckmark("New cycle started");
}
async function deleteCategory(id){
  if(!confirm("Delete this category? Its past transactions stay in the monthly files but will show as (deleted).")) return;
  const c = STATE.categories.find(x=>x.id===id);
  const result = await api(`/api/categories/${id}`, {method:"DELETE"});
  allocSelected.delete(id);
  await refresh();
  showUndoToast(`Deleted ${c.icon} ${c.name}`, async ()=>{
    await api(`/api/trash/${result.trashId}/restore`, {method:"POST"});
    await refresh();
  });
}
async function deleteTransaction(id){
  const result = await api(`/api/transactions/${id}`, {method:"DELETE"});
  await refresh();
  showUndoToast("Transaction deleted", async ()=>{
    await api(`/api/trash/${result.trashId}/restore`, {method:"POST"});
    await refresh();
  });
}

/* ---- icon picker ---- */
const ICON_CHOICES = ["🚨","🏥","🔧","🕋","🐑","🏠","🚗","🏍","🏖","👤","🎓","⚠","🛍","📈","💰","🍎",
  "🎁","🐣","👶","💼","📱","💻","🧾","⚽","🎮","🐾","✈️","🏦","💊","🧳","🛠","🎉"];
function openIconPicker(){
  const grid = document.getElementById("icon-grid");
  grid.innerHTML = ICON_CHOICES.map(ic=>`<button type="button" onclick="selectIcon('${ic}')">${ic}</button>`).join("");
  openModal("icon-picker-modal-bg");
}
function selectIcon(icon){
  document.getElementById("cat-icon").value = icon;
  document.getElementById("cat-icon-btn").textContent = icon;
  closeModal("icon-picker-modal-bg");
}

/* ---- undo toast ---- */
let undoTimer = null;
function showUndoToast(msg, undoFn){
  const t = document.getElementById("toast");
  clearTimeout(undoTimer);
  t.innerHTML = `${msg} <button class="mini" style="margin-left:10px;background:transparent;border-color:#fff;color:#fff;" id="undo-btn">Undo</button>`;
  t.classList.add("show");
  document.getElementById("undo-btn").onclick = async ()=>{
    t.classList.remove("show");
    clearTimeout(undoTimer);
    await undoFn();
    showToast("Restored");
  };
  undoTimer = setTimeout(()=>t.classList.remove("show"), 5000);
}

/* ---- money add/withdraw ---- */
function openMoneyModal(catId, direction){
  document.getElementById("money-cat-id").value = catId;
  document.getElementById("money-direction").value = direction;
  document.getElementById("money-modal-title").textContent = direction==="add" ? "Add money" : "Withdraw money";
  document.getElementById("money-amount").value = "";
  document.getElementById("money-date").value = todayStr();
  document.getElementById("money-note").value = "";
  document.getElementById("money-tags").value = "";
  openModal("money-modal-bg");
}
async function saveMoney(){
  const catId = document.getElementById("money-cat-id").value;
  const direction = document.getElementById("money-direction").value;
  let amount = parseFloat(document.getElementById("money-amount").value);
  if(!amount || amount<=0){ showToast("Enter a valid amount"); return; }
  if(direction==="remove") amount = -amount;
  const tags = document.getElementById("money-tags").value.split(",").map(t=>t.trim()).filter(Boolean);
  await api("/api/transactions", {method:"POST", body:JSON.stringify({
    categoryId: catId,
    date: document.getElementById("money-date").value || todayStr(),
    amount, note: document.getElementById("money-note").value.trim(), tags
  })});
  closeModal("money-modal-bg");
  await refresh();
  showCheckmark("Recorded");
}

/* ---- edit transaction ---- */
function openEditTransaction(id){
  const t = STATE.transactions.find(x=>x.id===id);
  if(!t) return;
  document.getElementById("edit-txn-id").value = t.id;
  const sel = document.getElementById("edit-txn-cat");
  sel.innerHTML = STATE.categories.map(c=>`<option value="${c.id}" ${c.id===t.categoryId?"selected":""}>${c.icon} ${c.name}</option>`).join("");
  document.getElementById("edit-txn-amount").value = t.amount;
  document.getElementById("edit-txn-date").value = t.date;
  document.getElementById("edit-txn-note").value = t.note || "";
  document.getElementById("edit-txn-tags").value = (t.tags || []).join(", ");
  openModal("edit-txn-modal-bg");
}
async function saveEditTransaction(){
  const id = document.getElementById("edit-txn-id").value;
  const tags = document.getElementById("edit-txn-tags").value.split(",").map(t=>t.trim()).filter(Boolean);
  await api(`/api/transactions/${id}`, {method:"PUT", body:JSON.stringify({
    categoryId: document.getElementById("edit-txn-cat").value,
    amount: parseFloat(document.getElementById("edit-txn-amount").value),
    date: document.getElementById("edit-txn-date").value,
    note: document.getElementById("edit-txn-note").value.trim(),
    tags,
  })});
  closeModal("edit-txn-modal-bg");
  await refresh();
  showCheckmark("Updated");
}

/* ===================== SURPLUS ALLOCATOR ===================== */
document.getElementById("strategy-tabs").addEventListener("click", e=>{
  const btn = e.target.closest("button[data-strategy]");
  if(!btn) return;
  allocStrategy = btn.dataset.strategy;
  document.querySelectorAll("#strategy-tabs button").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
  renderAllocatorControls();
});

let allocIncrement = 100;
document.getElementById("increment-tabs").addEventListener("click", e=>{
  const btn = e.target.closest("button[data-increment]");
  if(!btn) return;
  allocIncrement = parseInt(btn.dataset.increment);
  document.querySelectorAll("#increment-tabs button").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
});

function renderAllocatorControls(){
  const chips = document.getElementById("alloc-chips");
  chips.innerHTML = [...STATE.categories].sort((a,b)=>a.priority-b.priority).map(c=>{
    const sel = allocSelected.has(c.id);
    return `<div class="chip ${sel?'selected':''}" onclick="toggleAllocCategory('${c.id}')">${c.icon} ${c.name} (P${c.priority})</div>`;
  }).join("") || '<div class="empty">No categories yet.</div>';

  const weightsBox = document.getElementById("custom-weights");
  if(allocStrategy === "custom"){
    weightsBox.style.display = "block";
    weightsBox.innerHTML = [...STATE.categories].filter(c=>allocSelected.has(c.id)).map(c=>`
      <div class="row" style="align-items:center;">
        <div style="flex:2;">${c.icon} ${c.name}</div>
        <div><input type="number" min="0" max="100" placeholder="%" id="weight-${c.id}" value="${(100/Math.max(1,allocSelected.size)).toFixed(0)}"></div>
      </div>`).join("");
  } else {
    weightsBox.style.display = "none";
  }
}
function toggleAllocCategory(id){
  if(allocSelected.has(id)) allocSelected.delete(id); else allocSelected.add(id);
  renderAllocatorControls();
}

const PRIORITY_CASCADE_SPAN = 5; // "smart priority" spreads across the top N relevant priorities, not just #1

function roundAllocPlan(pool, remaining, increment){
  // floor every allocation to the nearest increment (matching the banknotes you actually have) so the
  // total never exceeds the surplus; whatever is lost to rounding is folded back into the leftover.
  let lostToRounding = 0;
  const plan = pool.filter(p=>p.alloc > 0).map(p=>{
    const rounded = Math.floor(p.alloc / increment) * increment;
    lostToRounding += (p.alloc - rounded);
    return {cat: p.cat, alloc: rounded};
  }).filter(p=>p.alloc > 0);
  return {plan, leftover: Math.max(0, remaining + lostToRounding)};
}

function waterFillAllocate(cats, amount, weightFn, increment){
  let remaining = amount;
  let pool = cats.map(c=>({cat:c, need: Math.max(0, c.target-categoryBalance(c.id)), weight: weightFn(c), alloc:0}));
  let active = pool.filter(p=>p.need>0 && p.weight>0);
  let guard = 0;
  while(remaining > 0.01 && active.length>0 && guard<50){
    guard++;
    const tw = active.reduce((s,p)=>s+p.weight,0);
    if(tw<=0) break;
    const passRemaining = remaining; // freeze the pool for this pass so shares are proportional to the
                                      // total available at the *start* of the pass, not a value shrinking
                                      // as each category in the loop takes its cut
    let anyCapped = false;
    for(const p of active){
      const share = passRemaining * (p.weight/tw);
      const room = p.need - p.alloc;
      const give = Math.min(share, room);
      p.alloc += give; remaining -= give;
      if(give < share - 0.01) anyCapped = true;
    }
    active = active.filter(p=>p.alloc < p.need - 0.01);
    if(!anyCapped) break;
  }
  return roundAllocPlan(pool, remaining, increment);
}

function forceFullAllocation(result, cats, increment){
  // Guarantees zero leftover: places remaining notes on whichever selected category still has room
  // (highest urgency first), and — only if every selected category is already fully funded — puts
  // the rest on the single highest-urgency category even if that means going past its target.
  let leftover = result.leftover;
  if(leftover <= 0.01 || cats.length === 0) return result;
  const planMap = new Map(result.plan.map(p=>[p.cat.id, p.alloc]));
  const sorted = [...cats].sort((a,b)=>(b.urgencyScore||0)-(a.urgencyScore||0));
  let guard = 0;
  while(leftover >= increment - 0.01 && guard < 1000){
    guard++;
    let placed = false;
    for(const c of sorted){
      const current = planMap.get(c.id) || 0;
      const need = Math.max(0, c.target - categoryBalance(c.id));
      if(current + increment <= need + 0.01){
        planMap.set(c.id, current + increment);
        leftover -= increment;
        placed = true;
        if(leftover < increment - 0.01) break;
      }
    }
    if(!placed) break; // nobody has room left within their target at this increment size
  }
  if(leftover > 0.01){
    const top = sorted[0];
    planMap.set(top.id, (planMap.get(top.id)||0) + leftover);
    leftover = 0;
  }
  const plan = [...planMap.entries()].filter(([,alloc])=>alloc>0)
    .map(([id,alloc])=>({cat: cats.find(c=>c.id===id), alloc}));
  return {plan, leftover: 0};
}

function computeAllocation(amount){
  const cats = STATE.categories.filter(c=>allocSelected.has(c.id));
  const increment = allocIncrement;
  // Real banknotes only come in the chosen denomination, so the usable surplus itself must be a
  // clean multiple of it — otherwise even a "fully allocated" plan could leave one category holding
  // an odd, non-note amount. Any true sub-note remainder (e.g. 50 out of a 2350 surplus with 200 notes)
  // is set aside and reported separately, never silently folded into a category's total.
  const usableAmount = Math.floor(amount / increment) * increment;
  const subNoteRemainder = amount - usableAmount;

  let result;
  if(allocStrategy === "priority"){
    // Smart ranking: priority is the dominant factor, but deadline urgency, recurring status,
    // and how far behind pace a goal is all shift the order too (see urgencyScore, computed server-side).
    const sorted = [...cats].sort((a,b)=>(b.urgencyScore||0)-(a.urgencyScore||0)).filter(c=>Math.max(0,c.target-categoryBalance(c.id))>0);
    const span = sorted.slice(0, PRIORITY_CASCADE_SPAN);
    const rankWeight = new Map(span.map((c,i)=>[c.id, span.length - i]));
    result = waterFillAllocate(span, usableAmount, c => rankWeight.get(c.id) || 0, increment);
  } else if(allocStrategy === "even"){
    result = waterFillAllocate(cats, usableAmount, () => 1, increment);
  } else if(allocStrategy === "custom"){
    const weights = {};
    cats.forEach(c=>{ const el = document.getElementById(`weight-${c.id}`); weights[c.id] = el ? (parseFloat(el.value)||0) : 0; });
    result = waterFillAllocate(cats, usableAmount, c => weights[c.id] || 0, increment);
  } else {
    result = {plan:[], leftover: usableAmount};
  }
  const forceFull = document.getElementById("alloc-force-full").checked;
  if(forceFull){
    result = forceFullAllocation(result, cats, increment);
  }
  result.subNoteRemainder = subNoteRemainder;
  return result;
}

let _pendingAllocation = null;
function previewAllocation(){
  const amount = parseFloat(document.getElementById("surplus-amount").value);
  const box = document.getElementById("alloc-result");
  if(!amount || amount<=0){ showToast("Enter a surplus amount first"); return; }
  if(allocSelected.size===0){ showToast("Select at least one category"); return; }
  const {plan, leftover, subNoteRemainder} = computeAllocation(amount);
  _pendingAllocation = plan;
  const subNoteLine = subNoteRemainder > 0.01
    ? `<div class="alloc-row" style="color:var(--muted);font-size:.82rem;"><span>Not a full ${allocIncrement}-note, set aside</span><span>${fmt(subNoteRemainder)}</span></div>` : "";
  if(plan.length===0){
    box.innerHTML = '<div class="empty">Selected categories are already fully funded — nothing to allocate.</div>' + subNoteLine;
    document.getElementById("apply-alloc-btn").style.display = "none";
    return;
  }
  const leftoverLine = leftover > 0.01
    ? `<div class="alloc-row" style="font-weight:700;border-bottom:none;"><span>Spread across ${plan.length} categor${plan.length===1?'y':'ies'} — left unallocated</span><span>${fmt(leftover)}</span></div>`
    : `<div class="alloc-row" style="font-weight:700;border-bottom:none;color:var(--green);"><span>Spread across ${plan.length} categor${plan.length===1?'y':'ies'} — 100% allocated</span><span>✅ ${fmt(0)} left over</span></div>`;
  box.innerHTML = plan.map(p=>`<div class="alloc-row"><span>${p.cat.icon} ${p.cat.name} (P${p.cat.priority})</span><span class="pos">+${fmt(p.alloc)}</span></div>`).join("") + leftoverLine + subNoteLine;
  document.getElementById("apply-alloc-btn").style.display = "inline-block";
}
async function applyAllocation(){
  if(!_pendingAllocation || _pendingAllocation.length===0) return;
  const allocations = _pendingAllocation.map(p=>({categoryId:p.cat.id, amount: Math.round(p.alloc), note:"Surplus allocation"}));
  await api("/api/allocate", {method:"POST", body:JSON.stringify({date: todayStr(), allocations})});
  document.getElementById("surplus-amount").value = "";
  document.getElementById("alloc-result").innerHTML = "";
  document.getElementById("apply-alloc-btn").style.display = "none";
  await refresh();
  showToast(`Allocated across ${allocations.length} categories`);
}

/* ===================== LOANS ===================== */
function openLoanModal(){
  document.getElementById("loan-type").value = "lent";
  document.getElementById("loan-person").value = "";
  document.getElementById("loan-amount").value = "";
  document.getElementById("loan-date").value = todayStr();
  document.getElementById("loan-note").value = "";
  openModal("loan-modal-bg");
}
async function saveLoan(){
  const body = {
    type: document.getElementById("loan-type").value,
    person: document.getElementById("loan-person").value.trim(),
    principal: parseFloat(document.getElementById("loan-amount").value),
    date: document.getElementById("loan-date").value,
    note: document.getElementById("loan-note").value.trim(),
  };
  if(!body.person || !body.principal || body.principal<=0){ showToast("Enter a person and amount"); return; }
  await api("/api/loans", {method:"POST", body:JSON.stringify(body)});
  closeModal("loan-modal-bg");
  await refresh();
  showToast("Loan added");
}
function openRepayModal(loanId){
  document.getElementById("repay-loan-id").value = loanId;
  document.getElementById("repay-amount").value = "";
  document.getElementById("repay-date").value = todayStr();
  document.getElementById("repay-note").value = "";
  openModal("repay-modal-bg");
}
async function saveRepayment(){
  const loanId = document.getElementById("repay-loan-id").value;
  const amount = parseFloat(document.getElementById("repay-amount").value);
  if(!amount || amount<=0){ showToast("Enter a valid amount"); return; }
  await api(`/api/loans/${loanId}/repayments`, {method:"POST", body:JSON.stringify({
    amount, date: document.getElementById("repay-date").value, note: document.getElementById("repay-note").value.trim()
  })});
  closeModal("repay-modal-bg");
  await refresh();
  showToast("Repayment logged");
}
async function deleteLoan(id){
  if(!confirm("Delete this loan and its repayment history?")) return;
  const result = await api(`/api/loans/${id}`, {method:"DELETE"});
  await refresh();
  showUndoToast("Loan deleted", async ()=>{
    await api(`/api/trash/${result.trashId}/restore`, {method:"POST"});
    await refresh();
  });
}
function downloadLoanPdf(id){ window.open(`/api/loans/${id}/pdf`, "_blank"); }
function downloadLoanImage(id){ window.open(`/api/loans/${id}/image`, "_blank"); }

function renderLoans(){
  const renderList = (type, container) => {
    const loans = STATE.loans.filter(l=>l.type===type);
    if(loans.length===0){ container.innerHTML = '<div class="empty">None recorded.</div>'; return; }
    container.innerHTML = loans.map(l=>{
      const remaining = loanRemaining(l);
      const paid = l.principal - remaining;
      const pct = l.principal>0 ? Math.round((paid/l.principal)*100) : 0;
      return `<div class="cat-card ${remaining<=0?'done':''}" style="margin-bottom:14px;">
        <div class="top">
          <div class="name">${l.person} <span class="tag ${type}">${type==='lent'?'They owe me':'I owe them'}</span></div>
          <span class="prio">${l.date}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="cat-nums"><span>Repaid ${fmt(paid)}</span><span>Remaining ${fmt(remaining)}</span></div>
        ${l.note ? `<div style="font-size:.8rem;color:var(--muted);margin-top:6px;">${l.note}</div>` : ""}
        <div class="cat-actions">
          <button class="mini" onclick="openRepayModal('${l.id}')">+ Log repayment</button>
          <button class="mini" onclick="downloadLoanPdf('${l.id}')">📄 PDF</button>
          <button class="mini" onclick="downloadLoanImage('${l.id}')">🖼 Image</button>
          <button class="mini danger" onclick="deleteLoan('${l.id}')">Delete</button>
        </div>
      </div>`;
    }).join("");
  };
  renderList("lent", document.getElementById("loans-lent"));
  renderList("borrowed", document.getElementById("loans-borrowed"));
}

/* ===================== MONTHLY TRENDS & MISSING-MONTH DETECTION ===================== */
function currentMonthKey(){ return todayStr().slice(0,7); }

function monthsBetween(startKey, endKey){
  const [sy, sm] = startKey.split("-").map(Number);
  const [ey, em] = endKey.split("-").map(Number);
  const out = [];
  let y = sy, m = sm;
  while(y < ey || (y === ey && m <= em)){
    out.push(`${y}-${String(m).padStart(2,"0")}`);
    m++; if(m>12){ m=1; y++; }
  }
  return out;
}
function monthlyNetTotals(){
  const map = {};
  STATE.transactions.forEach(t=>{ map[t.month] = (map[t.month]||0) + t.amount; });
  return map;
}
function monthlyCounts(){
  const map = {};
  STATE.transactions.forEach(t=>{ map[t.month] = (map[t.month]||0) + 1; });
  return map;
}
function getExpectedMonths(){
  if(STATE.transactions.length===0) return [];
  const earliest = STATE.transactions.reduce((min,t)=> t.month<min?t.month:min, STATE.transactions[0].month);
  return monthsBetween(earliest, currentMonthKey());
}
function getMissingMonths(){
  const counts = monthlyCounts();
  const dismissed = new Set(SETTINGS.dismissedMissingMonths || []);
  return getExpectedMonths().filter(mk => !counts[mk] && !dismissed.has(mk));
}

/* ---- shared floating tooltip for all charts ---- */
function ensureTooltipEl(){
  let tip = document.getElementById("chart-tooltip");
  if(!tip){
    tip = document.createElement("div");
    tip.id = "chart-tooltip";
    tip.className = "chart-floating-tooltip";
    document.body.appendChild(tip);
  }
  return tip;
}
function showChartTooltip(evt, text){
  const tip = ensureTooltipEl();
  tip.textContent = text;
  tip.style.left = (evt.clientX + 14) + "px";
  tip.style.top = (evt.clientY + 10) + "px";
  tip.style.opacity = "1";
}
function hideChartTooltip(){
  const tip = document.getElementById("chart-tooltip");
  if(tip) tip.style.opacity = "0";
}

const CHART_DEFS = `
  <defs>
    <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3f7ab0"></stop>
      <stop offset="100%" stop-color="#1f4e78"></stop>
    </linearGradient>
    <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1f4e78" stop-opacity="0.35"></stop>
      <stop offset="100%" stop-color="#1f4e78" stop-opacity="0"></stop>
    </linearGradient>
  </defs>`;

const DONUT_COLORS = ["#1f4e78","#3f7ab0","#f2c94c","#1e9e6b","#c0392b","#8e5fb0","#e08e45","#3aafa9","#c9184a","#6c757d"];

/* ---- animated, interactive donut chart ---- */
function renderDonutChart(containerId, segments, opts={}){
  const container = document.getElementById(containerId);
  if(!container) return;
  const total = segments.reduce((s,x)=>s+x.value,0);
  if(total <= 0){ container.innerHTML = '<div class="empty">Nothing to show yet.</div>'; return; }
  const size = opts.size || 200, thickness = opts.thickness || 26;
  const radius = (size - thickness) / 2, cx = size/2, cy = size/2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segs = segments.map((seg,i)=>{
    const frac = seg.value/total;
    const dash = frac*circumference;
    const s = { ...seg, dash, offset, color: seg.color || DONUT_COLORS[i % DONUT_COLORS.length], pct: Math.round(frac*100) };
    offset += dash;
    return s;
  });
  const circles = segs.map(s => `<circle class="donut-seg" cx="${cx}" cy="${cy}" r="${radius}" fill="none"
      stroke="${s.color}" stroke-width="${thickness}"
      stroke-dasharray="0 ${circumference.toFixed(1)}"
      data-final-dash="${s.dash.toFixed(1)} ${(circumference-s.dash).toFixed(1)}"
      stroke-dashoffset="${(-s.offset).toFixed(1)}"
      transform="rotate(-90 ${cx} ${cy})"
      data-label="${s.label}" data-value="${s.value}" data-pct="${s.pct}"></circle>`).join("");

  container.innerHTML = `
    <div style="position:relative;width:${size}px;height:${size}px;">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${circles}</svg>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;">
        <div class="donut-center-label">${opts.centerValue || fmt(total)}</div>
        <div class="gauge-sub">${opts.centerLabel || "Total"}</div>
      </div>
    </div>
    <div class="donut-legend">${segs.map(s=>`<div class="legend-item"><span class="dot" style="background:${s.color}"></span>${s.label}: ${fmt(s.value)} (${s.pct}%)</div>`).join("")}</div>
  `;
  // animate in
  requestAnimationFrame(()=>{
    container.querySelectorAll(".donut-seg").forEach(el=>{
      el.setAttribute("stroke-dasharray", el.dataset.finalDash);
    });
  });
  container.querySelectorAll(".donut-seg").forEach(el=>{
    el.addEventListener("mousemove", e=>showChartTooltip(e, `${el.dataset.label}: ${fmt(+el.dataset.value)} (${el.dataset.pct}%)`));
    el.addEventListener("mouseleave", hideChartTooltip);
  });
}

/* ---- animated semi-circle gauge (e.g. wealth vs Nisab) ---- */
function renderGaugeChart(containerId, value, max, opts={}){
  const container = document.getElementById(containerId);
  if(!container) return;
  const size = 220, thickness = 22;
  const radius = (size - thickness) / 2, cx = size/2, cy = size/2 + 6;
  const halfCirc = Math.PI * radius;
  const pct = Math.max(0, Math.min(1, max>0 ? value/max : 0));
  const good = opts.good !== false;
  const color = good ? "var(--green)" : "var(--red)";
  container.innerHTML = `
    <svg width="${size}" height="${size/2 + 30}" viewBox="0 0 ${size} ${size/2 + 30}">
      <path d="M ${cx-radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx+radius} ${cy}" fill="none" stroke="var(--border)" stroke-width="${thickness}" stroke-linecap="round"></path>
      <path id="${containerId}-fill" d="M ${cx-radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx+radius} ${cy}" fill="none" stroke="${color}" stroke-width="${thickness}" stroke-linecap="round"
        stroke-dasharray="0 ${halfCirc.toFixed(1)}"></path>
    </svg>
    <div class="gauge-value">${Math.round(pct*100)}%</div>
    <div class="gauge-sub">${opts.subtitle || ""}</div>
  `;
  requestAnimationFrame(()=>{
    const el = document.getElementById(`${containerId}-fill`);
    if(el) el.setAttribute("stroke-dasharray", `${(pct*halfCirc).toFixed(1)} ${halfCirc.toFixed(1)}`);
  });
}

/* ---- tiny dependency-free SVG chart helpers ---- */
function renderBarChart(containerId, labels, values, opts={}){
  const container = document.getElementById(containerId);
  if(!container) return;
  const W = container.clientWidth || 900;
  const H = opts.height || 220;
  const padL = 55, padR = 20, padT = 24, padB = 34;
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const maxV = Math.max(1, ...values, 0);
  const minV = Math.min(0, ...values);
  const range = (maxV - minV) || 1;
  const yFor = v => padT + chartH - ((v - minV) / range) * chartH;
  const baseline = yFor(0);
  const gap = chartW / Math.max(1, values.length);
  const barW = Math.max(3, gap * 0.6);
  const step = Math.max(1, Math.ceil(labels.length / 14));

  let bars = "", labelsSvg = "";
  values.forEach((v,i)=>{
    const x = padL + i*gap + (gap-barW)/2;
    const y = Math.min(yFor(v), baseline);
    const h = Math.max(1, Math.abs(yFor(v) - baseline));
    const cls = (opts.missingSet && opts.missingSet.has(labels[i])) ? "bar missing" : "bar";
    bars += `<rect class="${cls}" x="${x.toFixed(1)}" y="${baseline.toFixed(1)}" width="${barW.toFixed(1)}" height="0" rx="3"
      data-final-y="${y.toFixed(1)}" data-final-h="${h.toFixed(1)}"
      data-label="${labels[i]}" data-value="${Math.round(v)}"></rect>`;
    if(i % step === 0){
      const labelText = opts.fullLabels ? labels[i] : labels[i].slice(2);
      labelsSvg += `<text class="axis-label" x="${(x+barW/2).toFixed(1)}" y="${H-12}" text-anchor="middle">${labelText}</text>`;
    }
  });
  container.innerHTML = `<svg class="svg-chart" viewBox="0 0 ${W} ${H}">
    ${CHART_DEFS}
    <line class="gridline" x1="${padL}" y1="${baseline.toFixed(1)}" x2="${W-padR}" y2="${baseline.toFixed(1)}"></line>
    ${bars}${labelsSvg}
  </svg>`;
  requestAnimationFrame(()=>{
    container.querySelectorAll(".bar").forEach(el=>{
      el.style.transition = "y .5s cubic-bezier(.22,1,.36,1), height .5s cubic-bezier(.22,1,.36,1)";
      el.setAttribute("y", el.dataset.finalY);
      el.setAttribute("height", el.dataset.finalH);
    });
  });
  container.querySelectorAll(".bar").forEach(el=>{
    el.addEventListener("mousemove", e=>showChartTooltip(e, `${el.dataset.label}: ${(+el.dataset.value).toLocaleString()} ${SETTINGS.currency||'MAD'}`));
    el.addEventListener("mouseleave", hideChartTooltip);
  });
}

function renderLineChart(containerId, labels, values){
  const container = document.getElementById(containerId);
  if(!container) return;
  const W = container.clientWidth || 900, H = 220;
  const padL = 55, padR = 20, padT = 24, padB = 34;
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const maxV = Math.max(1, ...values);
  const minV = Math.min(0, ...values);
  const range = (maxV - minV) || 1;
  const n = Math.max(1, values.length - 1);
  const xFor = i => padL + (chartW * i / n);
  const yFor = v => padT + chartH - ((v - minV) / range) * chartH;
  const baseline = yFor(Math.max(minV,0));
  const points = values.map((v,i)=>`${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(" ");
  const areaPoints = `${padL.toFixed(1)},${baseline.toFixed(1)} ${points} ${xFor(n).toFixed(1)},${baseline.toFixed(1)}`;
  const step = Math.max(1, Math.ceil(labels.length / 10));
  let dots = "", labelsSvg = "";
  values.forEach((v,i)=>{
    dots += `<circle class="dot" cx="${xFor(i).toFixed(1)}" cy="${yFor(v).toFixed(1)}" r="3.5"
      data-label="${labels[i]}" data-value="${Math.round(v)}"></circle>`;
    if(i % step === 0){
      labelsSvg += `<text class="axis-label" x="${xFor(i).toFixed(1)}" y="${H-12}" text-anchor="middle">${labels[i].slice(2)}</text>`;
    }
  });
  const pathLen = 2000; // generous overestimate, works fine for dash animation purposes
  container.innerHTML = `<svg class="svg-chart" viewBox="0 0 ${W} ${H}">
    ${CHART_DEFS}
    <polygon class="area" points="${areaPoints}" style="opacity:0;"></polygon>
    <polyline class="line" points="${points}" stroke-dasharray="${pathLen}" stroke-dashoffset="${pathLen}"></polyline>
    ${dots}${labelsSvg}
  </svg>`;
  requestAnimationFrame(()=>{
    const line = container.querySelector(".line");
    const area = container.querySelector(".area");
    if(line){ line.style.transition = "stroke-dashoffset 1s cubic-bezier(.22,1,.36,1)"; line.setAttribute("stroke-dashoffset","0"); }
    if(area){ area.style.transition = "opacity .8s ease .3s"; area.style.opacity = "1"; }
  });
  container.querySelectorAll(".dot").forEach(el=>{
    el.addEventListener("mousemove", e=>showChartTooltip(e, `${el.dataset.label}: ${(+el.dataset.value).toLocaleString()} ${SETTINGS.currency||'MAD'}`));
    el.addEventListener("mouseleave", hideChartTooltip);
  });
}

function renderMissingBanners(missing){
  const summary = missing.length
    ? `<div class="banner warn"><span>⚠ <b>${missing.length}</b> month${missing.length>1?'s':''} without any entry: ${missing.join(", ")}</span><button class="ghost" onclick="goToView('trends')">Review</button></div>`
    : "";
  document.getElementById("missing-banner").innerHTML = summary;
  document.getElementById("trends-missing-banner").innerHTML = missing.length
    ? `<div class="banner warn" style="flex-direction:column;align-items:flex-start;">
        <span>⚠ No entries logged for the months below — add a transaction whenever you catch up, or dismiss a month if it's expected to stay empty.</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          ${missing.map(mk=>`<span class="month-pill">${mk} <button class="mini" style="margin-left:4px;" onclick="dismissMissingMonth('${mk}')">Dismiss ✕</button></span>`).join("")}
        </div>
      </div>`
    : "";
}
async function dismissMissingMonth(month){
  await api("/api/settings/dismiss-missing-month", {method:"POST", body:JSON.stringify({month})});
  await refresh();
  showToast(`${month} dismissed`);
}
async function undismissMissingMonth(month){
  await api("/api/settings/undismiss-missing-month", {method:"POST", body:JSON.stringify({month})});
  await refresh();
  showToast(`${month} restored to missing list`);
}
function goToView(view){
  document.querySelector(`nav button[data-view="${view}"]`).click();
}

function renderCategoryChart(){
  const catId = document.getElementById("trends-category-filter").value;
  const expected = getExpectedMonths();
  if(expected.length===0){ document.getElementById("chart-category").innerHTML = '<div class="empty">Not enough data yet.</div>'; return; }
  const values = expected.map(mk =>
    STATE.transactions.filter(t=>t.month===mk && (!catId || t.categoryId===catId)).reduce((s,t)=>s+t.amount,0)
  );
  renderBarChart("chart-category", expected, values, {});
}
document.getElementById("trends-category-filter").addEventListener("change", renderCategoryChart);

function renderTrends(){
  const expected = getExpectedMonths();
  const missing = getMissingMonths();
  const missingSet = new Set(missing);
  const dismissedSet = new Set(SETTINGS.dismissedMissingMonths || []);
  renderMissingBanners(missing);

  if(expected.length===0){
    ["chart-monthly-net","chart-cumulative","chart-category"].forEach(id=>{
      document.getElementById(id).innerHTML = '<div class="empty">Not enough data yet — add a transaction to see trends.</div>';
    });
    document.querySelector("#trends-table tbody").innerHTML = '<tr><td colspan="4" class="empty">Not enough data yet.</td></tr>';
    return;
  }

  const totals = monthlyNetTotals();
  const counts = monthlyCounts();

  renderBarChart("chart-monthly-net", expected, expected.map(mk=>totals[mk]||0), {missingSet});

  let running = 0;
  const cumValues = expected.map(mk => (running += (totals[mk]||0)));
  renderLineChart("chart-cumulative", expected, cumValues);

  const sel = document.getElementById("trends-category-filter");
  const prevVal = sel.value;
  sel.innerHTML = '<option value="">All categories (total)</option>' +
    STATE.categories.map(c=>`<option value="${c.id}">${c.icon} ${c.name}</option>`).join("");
  sel.value = prevVal;
  renderCategoryChart();

  document.querySelector("#trends-table tbody").innerHTML = [...expected].reverse().map(mk=>{
    const hasEntries = (counts[mk]||0) > 0;
    const isDismissed = dismissedSet.has(mk) && !hasEntries;
    const isMissing = missingSet.has(mk);
    const net = totals[mk] || 0;
    let statusCell;
    if(hasEntries) statusCell = `<span class="status-ok">✅ Logged</span>`;
    else if(isDismissed) statusCell = `<span style="color:var(--muted);">🔕 Dismissed <button class="mini" onclick="undismissMissingMonth('${mk}')">Undo</button></span>`;
    else statusCell = `<span class="status-missing">⚠ Missing</span> <button class="mini" onclick="dismissMissingMonth('${mk}')">Dismiss</button>`;
    return `<tr>
      <td>${mk}</td>
      <td>${counts[mk]||0}</td>
      <td class="${net>=0?'pos':'neg'}">${net>=0?'+':''}${fmt(net)}</td>
      <td>${statusCell}</td>
    </tr>`;
  }).join("");

  renderYearlySummary(totals);
}

function renderYearlySummary(totals){
  const byYear = {};
  Object.entries(totals).forEach(([mk, v])=>{
    const y = mk.slice(0,4);
    byYear[y] = (byYear[y]||0) + v;
  });
  const years = Object.keys(byYear).sort();
  const tbody = document.querySelector("#yearly-table tbody");
  if(years.length===0){ tbody.innerHTML = '<tr><td colspan="3" class="empty">Not enough data yet.</td></tr>'; return; }
  tbody.innerHTML = years.map((y,i)=>{
    const val = byYear[y];
    const prev = i>0 ? byYear[years[i-1]] : null;
    let deltaTxt = "—";
    if(prev !== null){
      const delta = prev===0 ? (val>0?100:0) : Math.round(((val-prev)/Math.abs(prev))*100);
      deltaTxt = `${delta>=0?'+':''}${delta}%`;
    }
    return `<tr><td>${y}</td><td class="${val>=0?'pos':'neg'}">${fmt(val)}</td><td>${deltaTxt}</td></tr>`;
  }).join("");
}

/* ===================== DEBTS ===================== */
function openDebtModal(id){
  document.getElementById("debt-modal-title").textContent = id ? "Edit Debt" : "New Debt";
  document.getElementById("debt-id").value = id || "";
  if(id){
    const d = STATE.debts.find(x=>x.id===id);
    document.getElementById("debt-description").value = d.description;
    document.getElementById("debt-type").value = d.type;
    document.getElementById("debt-original").value = d.originalAmount;
    document.getElementById("debt-monthly").value = d.monthlyPayment;
    document.getElementById("debt-start").value = d.startDate;
    document.getElementById("debt-note").value = d.note || "";
  } else {
    document.getElementById("debt-description").value = "";
    document.getElementById("debt-type").value = "Mourabaha";
    document.getElementById("debt-original").value = "";
    document.getElementById("debt-monthly").value = "";
    document.getElementById("debt-start").value = todayStr();
    document.getElementById("debt-note").value = "";
  }
  openModal("debt-modal-bg");
}
async function saveDebt(){
  const id = document.getElementById("debt-id").value;
  const body = {
    description: document.getElementById("debt-description").value.trim(),
    type: document.getElementById("debt-type").value,
    originalAmount: parseFloat(document.getElementById("debt-original").value) || 0,
    monthlyPayment: parseFloat(document.getElementById("debt-monthly").value) || 0,
    startDate: document.getElementById("debt-start").value || todayStr(),
    note: document.getElementById("debt-note").value.trim(),
  };
  if(!body.description){ showToast("Please enter a description"); return; }
  if(id) await api(`/api/debts/${id}`, {method:"PUT", body:JSON.stringify(body)});
  else await api("/api/debts", {method:"POST", body:JSON.stringify(body)});
  closeModal("debt-modal-bg");
  await refresh();
  showToast("Saved");
}
async function deleteDebt(id){
  if(!confirm("Delete this debt record?")) return;
  const result = await api(`/api/debts/${id}`, {method:"DELETE"});
  await refresh();
  showUndoToast("Debt deleted", async ()=>{
    await api(`/api/trash/${result.trashId}/restore`, {method:"POST"});
    await refresh();
  });
}
function renderDebts(){
  const wrap = document.getElementById("debts-cards");
  const panel = document.getElementById("debts-donut-panel");
  if(!STATE.debts || STATE.debts.length===0){
    panel.style.display = "none";
    wrap.innerHTML = `<div class="empty-guided" style="grid-column:1/-1;">
      <div class="big">🏦</div><h3>No debts recorded</h3>
      <p>Track Mourabaha financing or other structured debts here — it feeds your Net Worth.</p>
      <button class="primary" onclick="openDebtModal()">+ New Debt</button>
    </div>`;
    return;
  }
  panel.style.display = "block";
  const totalOriginal = STATE.debts.reduce((s,d)=>s+d.originalAmount,0);
  const totalRemaining = totalDebtsRemaining();
  const totalPaid = Math.max(0, totalOriginal - totalRemaining);
  renderDonutChart("chart-debts-donut", [
    {label:"Paid off", value: totalPaid, color:"#1e9e6b"},
    {label:"Remaining", value: totalRemaining, color:"#c0392b"},
  ], {centerValue: `${totalOriginal>0?Math.round(totalPaid/totalOriginal*100):0}%`, centerLabel:"Paid off"});
  wrap.innerHTML = STATE.debts.map(d=>{
    const pct = d.originalAmount>0 ? Math.round(((d.originalAmount-d.remaining)/d.originalAmount)*100) : 0;
    return `<div class="cat-card ${d.remaining<=0?'done':''}">
      <div class="top"><div class="name">🏦 ${d.description}</div><span class="prio">${d.type}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="cat-nums"><span>${fmt(d.originalAmount-d.remaining)} paid (${pct}%)</span><span>${fmt(d.remaining)} remaining (${100-pct}%)</span></div>
      ${d.note?`<div style="font-size:.8rem;color:var(--muted);margin-top:6px;">${d.note}</div>`:""}
      <div class="cat-actions">
        <button class="mini" onclick="openDebtModal('${d.id}')">Edit</button>
        <button class="mini danger" onclick="deleteDebt('${d.id}')">Delete</button>
      </div>
    </div>`;
  }).join("");
}

/* ===================== BUDGET ===================== */
function addBudgetExpenseRow(){
  BUDGET.expenses.push({id:"tmp_"+Math.random().toString(36).slice(2,8), name:"", amount:0});
  renderBudget();
}
function removeBudgetExpenseRow(id){
  BUDGET.expenses = BUDGET.expenses.filter(e=>e.id!==id);
  renderBudget();
}
function renderBudget(){
  document.getElementById("budget-income").value = BUDGET.monthlyIncome;
  const wrap = document.getElementById("budget-expenses");
  wrap.innerHTML = BUDGET.expenses.map(e=>`
    <div class="row" style="align-items:center;">
      <div style="flex:2;"><input value="${e.name}" oninput="updateBudgetField('${e.id}','name',this.value)" placeholder="Expense name"></div>
      <div><input type="number" value="${e.amount}" oninput="updateBudgetField('${e.id}','amount',this.value)"></div>
      <div style="flex:0;"><button class="mini danger" onclick="removeBudgetExpenseRow('${e.id}')">✕</button></div>
    </div>`).join("");
  const totalExpenses = BUDGET.expenses.reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  const income = parseFloat(document.getElementById("budget-income").value) || 0;
  const available = income - totalExpenses;
  document.getElementById("budget-summary").innerHTML = `
    <div class="row">
      <div class="kpi"><div class="label">Total fixed expenses</div><div class="value">${fmt(totalExpenses)}</div></div>
      <div class="kpi ${available>=0?'good':'warn'}"><div class="label">Available after expenses</div><div class="value">${fmt(available)}</div></div>
    </div>`;

  document.getElementById("budget-5030-20").innerHTML = income>0 ? `
    <h2 style="margin-top:0">Suggested split (50/30/20 rule)</h2>
    <p style="color:var(--muted);font-size:.82rem;margin-top:-6px;">A common starting point, not a rule you have to follow: 50% needs, 30% wants, 20% savings.</p>
    <div class="row">
      <div class="kpi"><div class="label">Needs (50%)</div><div class="value">${fmt(income*0.5)}</div></div>
      <div class="kpi"><div class="label">Wants (30%)</div><div class="value">${fmt(income*0.3)}</div></div>
      <div class="kpi"><div class="label">Savings (20%)</div><div class="value">${fmt(income*0.2)}</div></div>
    </div>` : `<p style="color:var(--muted);font-size:.85rem;margin:0;">Enter your monthly income above to see a suggested 50/30/20 split.</p>`;

  const donutSegs = BUDGET.expenses.filter(e=>(parseFloat(e.amount)||0)>0).map(e=>({label: e.name || "Expense", value: parseFloat(e.amount)||0}));
  renderDonutChart("chart-budget-donut", donutSegs, {centerValue: fmt(totalExpenses), centerLabel: "Fixed expenses"});

  renderBarChart("chart-income-bar", ["Expenses","Available"], [totalExpenses, Math.max(0,available)], {height: 160, fullLabels: true});

  const histBody = document.querySelector("#budget-history-table tbody");
  histBody.innerHTML = (BUDGET_HISTORY && BUDGET_HISTORY.length) ? [...BUDGET_HISTORY].reverse().map(h=>`
    <tr><td>${h.date}</td><td>${fmt(h.income)}</td><td>${fmt(h.totalExpenses)}</td></tr>
  `).join("") : '<tr><td colspan="3" class="empty">No history yet — it builds up each time you save the budget.</td></tr>';
}
function updateBudgetField(id, field, value){
  const e = BUDGET.expenses.find(x=>x.id===id);
  if(!e) return;
  e[field] = field==="amount" ? parseFloat(value)||0 : value;
  renderBudget();
}
async function saveBudget(){
  BUDGET.monthlyIncome = parseFloat(document.getElementById("budget-income").value) || 0;
  await api("/api/budget", {method:"PUT", body:JSON.stringify(BUDGET)});
  await refresh();
  showCheckmark("Budget saved");
}

/* ===================== ZAKAT ===================== */
function renderZakat(){
  if(!ZAKAT) return;
  const s = ZAKAT.settings;
  document.getElementById("zakat-reference").value = s.nisabReference;
  document.getElementById("zakat-gold-price").value = s.goldPricePerGram;
  document.getElementById("zakat-silver-price").value = s.silverPricePerGram;
  document.getElementById("zakat-prices-date").value = s.pricesUpdatedOn;
  document.getElementById("zakat-include-savings").value = s.includePlannerSavings ? "Yes" : "No";
  document.getElementById("zakat-other-wealth").value = s.otherWealth;
  document.getElementById("zakat-debts-deductible").value = s.debtsDeductible;
  document.getElementById("zakat-hawl-method").value = s.hawlMethod;
  document.getElementById("zakat-manual-start").value = s.manualHawlStart;

  document.getElementById("zakat-stale-banner").innerHTML = ZAKAT.priceStale
    ? `<div class="banner warn">⚠ Gold/silver prices haven't been updated in over 90 days — refresh them in the panel below for an accurate Nisab.</div>` : "";

  let hawlBanner = "";
  if(ZAKAT.aboveNisab && ZAKAT.daysRemaining !== null && ZAKAT.daysRemaining !== undefined){
    if(ZAKAT.daysRemaining < 0){
      hawlBanner = `<div class="banner warn">🕌 Zakat has been due since ${ZAKAT.dueDate} — see the Result section below.</div>`;
    } else if(ZAKAT.daysRemaining <= 30){
      hawlBanner = `<div class="banner warn">🕌 Zakat will be due in ${ZAKAT.daysRemaining} day${ZAKAT.daysRemaining===1?'':'s'} (${ZAKAT.dueDate}) if your wealth stays above Nisab.</div>`;
    }
  }
  document.getElementById("zakat-hawl-banner").innerHTML = hawlBanner;

  document.getElementById("zakat-kpis").innerHTML = `
    <div class="kpi"><div class="label">Nisab value</div><div class="value">${fmt(ZAKAT.nisabValue)}</div></div>
    <div class="kpi"><div class="label">Zakatable wealth</div><div class="value">${fmt(ZAKAT.zakatableWealth)}</div></div>
    <div class="kpi ${ZAKAT.aboveNisab?'good':''}"><div class="label">Above Nisab?</div><div class="value" style="font-size:1.2rem;">${ZAKAT.aboveNisab?'Yes':'No'}</div></div>
    <div class="kpi"><div class="label">Hawl start</div><div class="value" style="font-size:1.05rem;">${ZAKAT.hawlStart||'—'}</div>${ZAKAT.hawlStartHijri?`<div class="gauge-sub">🌙 ${ZAKAT.hawlStartHijri}</div>`:''}</div>
    <div class="kpi"><div class="label">Due date (1 Hijri year later)</div><div class="value" style="font-size:1.05rem;">${ZAKAT.dueDate||'—'}</div>${ZAKAT.dueDateHijri?`<div class="gauge-sub">🌙 ${ZAKAT.dueDateHijri}</div>`:''}</div>
    <div class="kpi ${ZAKAT.zakatDueNow>0?'warn':''}"><div class="label">Zakat due now</div><div class="value">${fmt(ZAKAT.zakatDueNow)}</div></div>
  `;
  if(ZAKAT.hijriAvailable === false){
    document.getElementById("zakat-stale-banner").innerHTML += `<div class="banner warn">⚠ Hijri calendar library unavailable — using a 354-day approximation for the Hawl instead of exact lunar dates.</div>`;
  }
  renderGaugeChart("chart-zakat-gauge", ZAKAT.zakatableWealth, Math.max(ZAKAT.nisabValue, ZAKAT.zakatableWealth, 1), {
    good: ZAKAT.aboveNisab,
    subtitle: `${fmt(ZAKAT.zakatableWealth)} of ${fmt(ZAKAT.nisabValue)} Nisab`,
  });

  const tbody = document.querySelector("#zakat-payments-table tbody");
  const payments = s.payments || [];
  tbody.innerHTML = payments.length ? payments.map(p=>`
    <tr><td>${formatDate(p.date)}</td><td>${fmt(p.amount)}</td><td>${p.reference||""}</td><td>${p.note||""}</td>
    <td><button class="mini danger" onclick="deleteZakatPayment('${p.id}')">✕</button></td></tr>
  `).join("") : '<tr><td colspan="5" class="empty">No payments logged yet.</td></tr>';
}
async function saveZakatSettings(){
  const body = {
    nisabReference: document.getElementById("zakat-reference").value,
    goldPricePerGram: parseFloat(document.getElementById("zakat-gold-price").value) || 0,
    silverPricePerGram: parseFloat(document.getElementById("zakat-silver-price").value) || 0,
    pricesUpdatedOn: document.getElementById("zakat-prices-date").value || todayStr(),
    includePlannerSavings: document.getElementById("zakat-include-savings").value === "Yes",
    otherWealth: parseFloat(document.getElementById("zakat-other-wealth").value) || 0,
    debtsDeductible: parseFloat(document.getElementById("zakat-debts-deductible").value) || 0,
    hawlMethod: document.getElementById("zakat-hawl-method").value,
    manualHawlStart: document.getElementById("zakat-manual-start").value || todayStr(),
  };
  await api("/api/zakat/settings", {method:"PUT", body:JSON.stringify(body)});
  await refresh();
  showToast("Zakat settings saved");
}
function openZakatPaymentModal(){
  document.getElementById("zp-amount").value = "";
  document.getElementById("zp-date").value = todayStr();
  document.getElementById("zp-reference").value = "";
  document.getElementById("zp-note").value = "";
  openModal("zakat-payment-modal-bg");
}
async function saveZakatPayment(){
  const amount = parseFloat(document.getElementById("zp-amount").value);
  if(!amount || amount<=0){ showToast("Enter a valid amount"); return; }
  await api("/api/zakat/payments", {method:"POST", body:JSON.stringify({
    amount, date: document.getElementById("zp-date").value,
    reference: document.getElementById("zp-reference").value.trim(),
    note: document.getElementById("zp-note").value.trim(),
  })});
  closeModal("zakat-payment-modal-bg");
  await refresh();
  showToast("Payment logged");
}
async function deleteZakatPayment(id){
  await api(`/api/zakat/payments/${id}`, {method:"DELETE"});
  await refresh();
}

/* ===================== SETTINGS ===================== */
function renderSettingsView(){
  document.getElementById("settings-currency").value = SETTINGS.currency;
  document.getElementById("settings-date-format").value = SETTINGS.dateFormat;
  document.getElementById("settings-backups-keep").value = SETTINGS.backupsToKeep;
  document.getElementById("settings-density").value = SETTINGS.density || "comfortable";
  document.getElementById("pin-autolock").value = SETTINGS.autoLockMinutes || 15;
  document.getElementById("pin-status").innerHTML = SETTINGS.pinEnabled
    ? '<span style="color:var(--green);">🔒 PIN protection is ON</span>'
    : '<span style="color:var(--muted);">🔓 No PIN set</span>';

  const btable = document.querySelector("#backups-table tbody");
  btable.innerHTML = BACKUPS.length ? BACKUPS.map(d=>`
    <tr><td>${d}</td><td><button class="mini" onclick="restoreBackup('${d}')">Restore</button></td></tr>
  `).join("") : '<tr><td colspan="2" class="empty">No backups yet — one is made automatically each day you open the app.</td></tr>';
}
async function saveSettings(){
  const body = {
    currency: document.getElementById("settings-currency").value.trim() || "MAD",
    dateFormat: document.getElementById("settings-date-format").value,
    backupsToKeep: parseInt(document.getElementById("settings-backups-keep").value) || 10,
    density: document.getElementById("settings-density").value,
    autoLockMinutes: parseInt(document.getElementById("pin-autolock").value) || 15,
  };
  await api("/api/settings", {method:"PUT", body:JSON.stringify(body)});
  await refresh();
  showCheckmark("Settings saved");
}
async function setPin(){
  const currentPin = document.getElementById("pin-current").value;
  const newPin = document.getElementById("pin-new").value;
  if(!newPin || newPin.length < 4){ showToast("PIN must be at least 4 digits"); return; }
  try{
    await api("/api/auth/set-pin", {method:"POST", body:JSON.stringify({currentPin, newPin})});
    document.getElementById("pin-current").value = "";
    document.getElementById("pin-new").value = "";
    await refresh();
    showCheckmark("PIN set");
  }catch(e){ showToast("Wrong current PIN"); }
}
async function disablePin(){
  const currentPin = document.getElementById("pin-current").value;
  try{
    await api("/api/auth/disable-pin", {method:"POST", body:JSON.stringify({currentPin})});
    document.getElementById("pin-current").value = "";
    await refresh();
    showToast("PIN disabled");
  }catch(e){ showToast("Wrong current PIN"); }
}
async function restoreBackup(date){
  if(!confirm(`Restore data from ${date}? Your current data will be safety-backed-up first, then overwritten.`)) return;
  await api(`/api/backups/${date}/restore`, {method:"POST"});
  await refresh();
  showToast("Backup restored");
}

let _pendingTawfeerFile = null;
async function previewTawfeerImport(evt){
  const file = evt.target.files[0];
  if(!file) return;
  _pendingTawfeerFile = file;
  const box = document.getElementById("tawfeer-import-preview");
  box.innerHTML = "Reading backup…";
  const formData = new FormData();
  formData.append("file", file);
  try{
    const res = await fetch("/api/import/tawfeer/preview", {method:"POST", body: formData});
    if(!res.ok) throw new Error(await res.text());
    const p = await res.json();
    const m = p.manifest;
    box.innerHTML = `
      <div class="panel" style="background:var(--bg);box-shadow:none;border:1px solid var(--border);">
        <h3 style="margin-top:0;">Tawfeer Backup</h3>
        <table><tbody>
          <tr><td>Created</td><td>${new Date(m.createdAt).toLocaleString()}</td></tr>
          <tr><td>App version</td><td>${m.appVersion}</td></tr>
          <tr><td>Backup format</td><td>v${m.backupVersion}</td></tr>
          <tr><td>Categories</td><td>${m.counts.categories}</td></tr>
          <tr><td>Transactions</td><td>${m.counts.transactions}</td></tr>
          <tr><td>Months</td><td>${m.counts.months}</td></tr>
          <tr><td>Loans</td><td>${m.counts.loans}</td></tr>
          <tr><td>Debts</td><td>${m.counts.debts}</td></tr>
          <tr><td>Compatibility</td><td>${p.compatible ? '✅ Compatible' : '❌ Not compatible with this version of Tawfeer'}</td></tr>
        </tbody></table>
        ${p.compatible ? `
          <p style="color:var(--red);font-size:.85rem;font-weight:600;">⚠ This will replace all current data in Tawfeer. A safety backup of what you have now is made automatically first.</p>
          <button class="primary" onclick="confirmTawfeerImport()">Restore this backup</button>
          <button class="ghost" onclick="document.getElementById('tawfeer-import-preview').innerHTML=''">Cancel</button>
        ` : ''}
      </div>`;
  }catch(e){
    box.innerHTML = `<div class="banner warn">Could not read this file: ${e.message}</div>`;
  }
  evt.target.value = "";
}
async function confirmTawfeerImport(){
  if(!_pendingTawfeerFile) return;
  const box = document.getElementById("tawfeer-import-preview");
  box.innerHTML = "Restoring…";
  const formData = new FormData();
  formData.append("file", _pendingTawfeerFile);
  try{
    const res = await fetch("/api/import/tawfeer/confirm", {method:"POST", body: formData});
    if(!res.ok) throw new Error(await res.text());
    const result = await res.json();
    box.innerHTML = `<div class="banner" style="background:#e6f4ea;color:#1e9e6b;border:1px solid #c6efce;">✅ Backup restored. A safety copy of your previous data was saved as <code>${result.safetyBackup}</code>.</div>`;
    await refresh();
    showCheckmark("Backup restored");
  }catch(e){
    box.innerHTML = `<div class="banner warn">Import failed: ${e.message}</div>`;
  }
  _pendingTawfeerFile = null;
}

async function importExcelFile(evt){
  const file = evt.target.files[0];
  if(!file) return;
  const resultBox = document.getElementById("import-result");
  resultBox.innerHTML = "Importing…";
  const formData = new FormData();
  formData.append("file", file);
  try{
    const res = await fetch("/api/import/excel", {method:"POST", body: formData});
    if(!res.ok){ throw new Error(await res.text()); }
    const summary = await res.json();
    resultBox.innerHTML = `
      <div class="banner" style="background:#e6f4ea;color:#1e9e6b;border:1px solid #c6efce;">
        ✅ Imported: ${summary.categoriesCreated} new categories, ${summary.categoriesMatched} matched to existing ones,
        ${summary.transactionsCreated} transactions created.
        ${summary.warnings.length ? '<br>⚠ ' + summary.warnings.join('<br>⚠ ') : ''}
      </div>`;
    await refresh();
  }catch(e){
    resultBox.innerHTML = `<div class="banner warn">Import failed: ${e.message}</div>`;
  }
  evt.target.value = "";
}

/* ===================== MONTHS ===================== */
function renderMonths(){
  const tbody = document.querySelector("#months-table tbody");
  if(STATE.months.length===0){ tbody.innerHTML = '<tr><td colspan="4" class="empty">No months yet.</td></tr>'; return; }
  tbody.innerHTML = [...STATE.months].sort().reverse().map(mk=>{
    const txns = STATE.transactions.filter(t=>t.month===mk);
    const net = txns.reduce((s,t)=>s+t.amount,0);
    return `<tr>
      <td>${mk}</td>
      <td>${txns.length}</td>
      <td class="${net>=0?'pos':'neg'}">${net>=0?'+':''}${fmt(net)}</td>
      <td><button class="mini danger" onclick="deleteMonth('${mk}')">Delete month</button></td>
    </tr>`;
  }).join("");
}
async function deleteMonth(mk){
  if(!confirm(`Delete ALL transactions for ${mk}? This cannot be undone.`)) return;
  await api(`/api/months/${mk}`, {method:"DELETE"});
  await refresh();
}

/* ===================== INIT ===================== */
function renderAll(){
  renderDashboard();
  renderCategories();
  renderAllocatorControls();
  renderLoans();
  renderDebts();
  renderBudget();
  renderZakat();
  renderTrends();
  renderMonths();
  renderSettingsView();
  renderTrashView();
}
window.addEventListener("resize", ()=>{ if(STATE.transactions) renderTrends(); });
refresh().catch(e=>showToast("Could not reach server: "+e.message));

/* ===================== TRASH ===================== */
function trashItemLabel(item){
  const d = item.data;
  if(item.type === "category") return `${d.icon || "💰"} ${d.name}`;
  if(item.type === "transaction") return `${fmt(d.amount)} — ${d.note || "no note"} (${d.date})`;
  if(item.type === "debt") return `${d.description} (${fmt(d.originalAmount)})`;
  if(item.type === "loan") return `${d.person} — ${fmt(d.principal)} (${item.data.type === "lent" ? "lent" : "borrowed"})`;
  return JSON.stringify(d).slice(0, 60);
}
function renderTrashView(){
  const tbody = document.querySelector("#trash-table tbody");
  if(!TRASH || TRASH.length === 0){
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Trash is empty.</td></tr>';
    return;
  }
  tbody.innerHTML = [...TRASH].reverse().map(item => `
    <tr>
      <td style="text-transform:capitalize;">${item.type}</td>
      <td>${trashItemLabel(item)}</td>
      <td>${item.deletedAt}</td>
      <td>
        <button class="mini" onclick="restoreFromTrash('${item.id}')">Restore</button>
        <button class="mini danger" onclick="deleteForever('${item.id}')">Delete forever</button>
      </td>
    </tr>`).join("");
}
async function restoreFromTrash(id){
  await api(`/api/trash/${id}/restore`, {method:"POST"});
  await refresh();
  showCheckmark("Restored");
}
async function deleteForever(id){
  if(!confirm("Permanently delete this item? This cannot be undone.")) return;
  await api(`/api/trash/${id}`, {method:"DELETE"});
  await refresh();
}
async function emptyTrash(){
  if(!TRASH || TRASH.length === 0) return;
  if(!confirm(`Permanently delete all ${TRASH.length} items in the trash?`)) return;
  await api("/api/trash", {method:"DELETE"});
  await refresh();
  showToast("Trash emptied");
}
