// Providers Hub 管理页。
//
// 页面沙盒（connect-src 'none'）没有 fetch —— 所有实时数据来自 snapshot.js：
// 由插件宿主（Bun，有文件权限）在 provider.models() / auth.usage() 时写出。
// 页面只改本插件自己的 options（plugins.json），不碰任何上游状态。
//
// ⚠️ 普通 <script src>（非 module）里 **顶层 await 是语法错误** → 整页「已停止工作」。
//    所有逻辑必须包在 async 函数里，并全量 try/catch。

function show(id, text) {
  const n = document.getElementById(id);
  if (n) n.textContent = text;
}

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
}

// 把分桶数组渲染成彩色小胶囊。
// ⚠️ 档位读宿主算好的 b.band，**不在页面按名字猜** —— OfficeAce 的桶名是
//    「个人体验版 / 新用户专属福利」，靠字样匹配会全变灰（真机报障）。
const BAND_CLASS = { 临期: ' hot', 长期: ' long', 永久: ' perm', 已耗尽: ' dead' };

function renderBuckets(td, buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    td.appendChild(el("span", "—", "muted"));
    return;
  }
  for (const b of buckets) {
    if (!b) continue;
    const name = String(b.name || "");
    let display = String(b.display || "");
    // 还剩多久：到期时刻优先（比 display 里上游自带的措辞更准）
    const at = b.runsOutAt || b.resetsAt;
    if (at) {
      const ms = Date.parse(at);
      if (Number.isFinite(ms)) {
        const left = ms - Date.now();
        const when = left <= 0 ? "已到期"
          : left < 3_600_000 ? Math.max(1, Math.round(left / 60_000)) + " 分钟后"
          : left < 86_400_000 ? Math.round(left / 3_600_000) + " 小时后"
          : Math.round(left / 86_400_000) + " 天后";
        // display 里常自带一次「N 天后作废」，避免重复
        if (!/后作废|到期|小时后/.test(display)) display = display ? display + " · " + when : when;
      }
    }
    const label = display ? name + "（" + display + "）" : name;
    td.appendChild(el("span", label, "pill" + (BAND_CLASS[b.band] || "")));
  }
}
function renderCheckin(td, checkin) {
  if (!checkin) { td.appendChild(el("span", "—", "muted")); return; }
  const outcome = String(checkin.outcome || "");
  const cls = outcome === "claimed" ? "ok"
    : outcome === "done" ? "ok"
    : outcome === "failed" ? "bad"
    : "muted";
  let text = outcome === "claimed" ? "已领取" + (checkin.credit ? " +" + checkin.credit : "")
    : outcome === "done" ? "今日已领"
    : outcome === "inactive" ? "无签到"
    : outcome === "ineligible" ? "不可领"
    : outcome === "failed" ? "失败" : outcome;
  td.appendChild(el("span", text, cls));
  if (checkin.message) td.appendChild(el("span", " " + checkin.message, "muted"));
}

// 重读快照：插一个带时间戳的 <script>（穿透缓存），加载完重渲染。
function reloadSnapshot() {
  const old = document.getElementById("snapDynamic");
  if (old) old.remove();
  const s = document.createElement("script");
  s.id = "snapDynamic";
  s.src = "snapshot.js?v=" + Date.now();
  s.onload = function () { renderSnapshot(); };
  document.head.appendChild(s);
}

function renderSnapshot() {
  const s = window.__PROVIDERS_HUB_SNAPSHOT__;
  if (!s || !Array.isArray(s.channels)) {
    show("summary", "暂无快照 —— 打开一次用量页 / 发起一次请求后，宿主会写出快照。");
    return;
  }
  show("summary", (s.provider || "Providers Hub") + " · " + s.channels.length + " 个渠道"
    + (s.models ? " · 共 " + s.models + " 个模型" : ""));

  const body = document.getElementById("channelsBody");
  const table = document.getElementById("channelsTable");
  if (!body || !table) return;
  body.innerHTML = "";
  for (const ch of s.channels) {
    const tr = el("tr");
    const nameTd = el("td", ch.displayName || ch.id);
    if (ch.backend) nameTd.appendChild(el("span", " " + ch.backend, "muted"));
    tr.appendChild(nameTd);

    const signTd = el("td");
    signTd.appendChild(el("span", ch.signedIn ? "已登录" : "未登录", ch.signedIn ? "ok" : "muted"));
    if (ch.expired) signTd.appendChild(el("span", " · 已过期", "bad"));
    // 账号槽数（accountId 相同 = magpie 原地更新，不同 = 并存）：>1 提醒有多个
    if (ch.accounts > 1) signTd.appendChild(el("span", " · " + ch.accounts + " 个账号", "muted"));
    tr.appendChild(signTd);

    tr.appendChild(el("td", ch.modelCount === undefined || ch.modelCount === null ? "—" : ch.modelCount, "num"));

    const bucketsTd = el("td");
    renderBuckets(bucketsTd, ch.buckets);
    tr.appendChild(bucketsTd);

    const ckTd = el("td");
    renderCheckin(ckTd, ch.checkin);
    tr.appendChild(ckTd);

    // 操作列：⚠️ 页面沙盒无法触发登录（magpie 的 read 只服务 usage:summary /
    // providers:list 两个内建项，自造名被服务端拒绝）—— 登录入口是供应商
    // 编辑器里的方式按钮（magpie 原生渲染 auth.methods）。这里如实提示。
    const actTd = el("td");
    actTd.appendChild(el("span", ch.signedIn ? "—" : "去「供应商」页登录", "muted"));
    tr.appendChild(actTd);

    body.appendChild(tr);
  }
  table.hidden = false;

  if (s.at) show("snapAt", "快照时间：" + new Date(s.at).toLocaleString());
}

async function main() {
  renderSnapshot();
  await magpie.ready;

  const opts = (await magpie.options.get()) || {};
  const input = document.getElementById("xff");
  if (input) input.value = typeof opts.minimaxXff === "string" ? opts.minimaxXff : "";

  // ── 刷新周期 ──
  // 自动刷新 = 重读本页快照文件（沙盒无网络，不碰上游；数据由宿主按 magpie
  // 自己的 usage 刷新节奏写出）。⚠️ 没有「立即刷新」按钮 —— 页面无法触发
  // 宿主查询（magpie 的 read 通道只有两个内建项），想立即更新就去用量页
  // 点一次刷新，回来这里自动跟上。
  let refreshTimer = null;
  const sel = document.getElementById("refreshEvery");
  const savedEvery = Number(opts.pageRefreshSeconds);
  if (sel) {
    sel.value = [5, 10, 30, 60].indexOf(savedEvery) !== -1 ? String(savedEvery) : "0";
    sel.onchange = async function () {
      const next = {};
      for (const k in opts) next[k] = opts[k];
      const v = Number(sel.value);
      if (v > 0) next.pageRefreshSeconds = v;
      else delete next.pageRefreshSeconds;
      Object.assign(opts, next);
      try { await magpie.options.set(next); } catch (e) { /* 保存失败仅影响下次启动 */ }
      armTimer(v);
    };
  }
  function armTimer(seconds) {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (seconds > 0) refreshTimer = setInterval(reloadSnapshot, seconds * 1000);
  }
  armTimer(savedEvery > 0 ? savedEvery : 0);

  // ── 页内登录 ──
  const save = document.getElementById("save");
  if (!save) { show("status", "页面结构缺失：#save"); return; }
  save.addEventListener("click", async function () {
    save.disabled = true;
    try {
      const next = {};
      for (const k in opts) next[k] = opts[k];
      const v = input ? input.value.trim() : "";
      if (v !== "") next.minimaxXff = v;
      else delete next.minimaxXff;
      await magpie.options.set(next);
      show("status", "已保存 — 到「插件」把 Providers Hub 关掉再打开生效");
    } catch (e) {
      show("status", "保存失败：" + String(e && e.message ? e.message : e));
    } finally {
      save.disabled = false;
    }
  });
}

if (typeof magpie === "undefined") {
  show("summary", "bridge 未加载：_magpie/bridge.js 没生效");
} else {
  Promise.resolve().then(main).catch(function (e) {
    show("summary", "页面出错：" + String(e && e.message ? e.message : e));
  });
}
