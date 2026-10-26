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

// 把分桶数组渲染成彩色小胶囊：临期=红、长期=黄、永久=绿、已耗尽=灰删除线
function renderBuckets(td, buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    td.appendChild(el("span", "—", "muted"));
    return;
  }
  for (const b of buckets) {
    const name = String(b && b.name ? b.name : "");
    const display = String(b && b.display ? b.display : "");
    let cls = "pill";
    if (name.indexOf("临期") !== -1) cls += " hot";
    else if (name.indexOf("长期") !== -1) cls += " long";
    else if (name.indexOf("永久") !== -1) cls += " perm";
    else if (name.indexOf("已耗尽") !== -1) cls += " dead";
    const label = display !== "" ? name + "（" + display + "）" : name;
    td.appendChild(el("span", label, cls));
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
    tr.appendChild(signTd);

    tr.appendChild(el("td", ch.modelCount === undefined || ch.modelCount === null ? "—" : ch.modelCount, "num"));

    const bucketsTd = el("td");
    renderBuckets(bucketsTd, ch.buckets);
    tr.appendChild(bucketsTd);

    const ckTd = el("td");
    renderCheckin(ckTd, ch.checkin);
    tr.appendChild(ckTd);

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
