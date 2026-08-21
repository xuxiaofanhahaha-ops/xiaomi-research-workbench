import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./overrides.css";

const quadrants = [
  { id: "urgent-important", label: "重要且紧急", hint: "现在处理", color: "#e88978" },
  { id: "important", label: "重要不紧急", hint: "深度推进", color: "#61b585" },
  { id: "urgent", label: "紧急不重要", hint: "快速完成", color: "#ddb55d" },
  { id: "later", label: "不紧急不重要", hint: "有余力再做", color: "#98a6b2" },
];

const emptyState = {
  tasks: [], inventory: [], invoices: [], habits: [], papers: [],
  petName: "小咪", dailyQuote: "把复杂的问题拆成今天能推进的一小步。",
  syncUpdatedAt: "", mobileSyncEnabled: true,
};
const stateKey = "xiaomi-mobile-workbench-v2";
const backupKey = `${stateKey}-backup`;
const configKey = "xiaomi-mobile-sync-config-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function uid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
function dateKey(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function normalize(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...emptyState, ...source,
    tasks: Array.isArray(source.tasks) ? source.tasks.map((task) => ({ ...task, subtasks: Array.isArray(task.subtasks) ? task.subtasks : [] })) : [],
    inventory: Array.isArray(source.inventory) ? source.inventory : [],
    invoices: Array.isArray(source.invoices) ? source.invoices : [],
    habits: Array.isArray(source.habits) ? source.habits : [],
    papers: Array.isArray(source.papers) ? source.papers : [],
  };
}
function hasContent(value) { return value.tasks.length || value.inventory.length || value.invoices.length || value.habits.length || value.papers.some((paper) => paper.favorite); }
function readJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch { return fallback; } }
function saveLocalSafely(value) {
  const serialized = JSON.stringify(normalize(value));
  JSON.parse(serialized);
  const current = localStorage.getItem(stateKey);
  if (current) localStorage.setItem(backupKey, current);
  localStorage.setItem(stateKey, serialized);
  if (localStorage.getItem(stateKey) !== serialized) throw new Error("本地保存校验失败");
}
function bytesToBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
function base64ToBytes(value) { const text = atob(value); return Uint8Array.from(text, (char) => char.charCodeAt(0)); }
async function encryptionKey(password, syncId) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: encoder.encode(`科研工作台:${syncId}`), iterations: 180000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptBytes(bytes, config) {
  const key = await encryptionKey(config.password, config.syncId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const packed = new Uint8Array(iv.length + encrypted.length);
  packed.set(iv); packed.set(encrypted, iv.length);
  return packed;
}
async function decryptBytes(bytes, config) {
  const key = await encryptionKey(config.password, config.syncId);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
}
async function encryptState(value, config) { return bytesToBase64(await encryptBytes(encoder.encode(JSON.stringify(normalize(value))), config)); }
async function decryptState(value, config) { return normalize(JSON.parse(decoder.decode(await decryptBytes(base64ToBytes(value), config)))); }
function validConfig(config) { return /^https:\/\/.+\.supabase\.co$/i.test(config.url || "") && (config.anonKey || "").length > 40 && (config.syncId || "").length >= 8 && (config.password || "").length >= 8; }
function headers(config, extras = {}) { return { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}`, ...extras }; }

async function pullRemote(config) {
  const response = await fetch(`${config.url}/rest/v1/workspace_state?id=eq.${encodeURIComponent(config.syncId)}&select=payload,updated_at`, { headers: headers(config), cache: "no-store" });
  if (!response.ok) throw new Error(`同步读取失败 ${response.status}`);
  const rows = await response.json();
  if (!rows[0]?.payload) return null;
  return await decryptState(rows[0].payload, config);
}
async function pushRemote(value, config) {
  const payload = await encryptState(value, config);
  const response = await fetch(`${config.url}/rest/v1/workspace_state?on_conflict=id`, {
    method: "POST",
    headers: headers(config, { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ id: config.syncId, payload, updated_at: value.syncUpdatedAt || new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`同步保存失败 ${response.status}`);
}
async function uploadEncryptedFile(file, config, path) {
  const encrypted = await encryptBytes(new Uint8Array(await file.arrayBuffer()), config);
  const response = await fetch(`${config.url}/storage/v1/object/workbench-files/${path}`, {
    method: "POST", headers: headers(config, { "Content-Type": "application/octet-stream", "x-upsert": "true" }), body: encrypted,
  });
  if (!response.ok) throw new Error(`文件上传失败 ${response.status}`);
  return path;
}
async function downloadEncryptedFile(path, config, mime) {
  const response = await fetch(`${config.url}/storage/v1/object/workbench-files/${path}`, { headers: headers(config) });
  if (!response.ok) throw new Error(`文件读取失败 ${response.status}`);
  const clear = await decryptBytes(new Uint8Array(await response.arrayBuffer()), config);
  return URL.createObjectURL(new Blob([clear], { type: mime || "application/octet-stream" }));
}

function App() {
  const [tab, setTab] = useState("today");
  const [state, setState] = useState(emptyState);
  const stateRef = useRef(state); stateRef.current = state;
  const [loaded, setLoaded] = useState(false);
  const [syncStatus, setSyncStatus] = useState("本地已保存");
  const [selectedDate, setSelectedDate] = useState(dateKey());
  const [inventoryType, setInventoryType] = useState("试剂");
  const [taskEditor, setTaskEditor] = useState(null);
  const [inventoryDraft, setInventoryDraft] = useState({ name: "", quantity: "", unit: "", location: "", status: "" });
  const [habitName, setHabitName] = useState("");
  const [toast, setToast] = useState("");
  const [config, setConfig] = useState(() => readJson(configKey, { url: "", anonKey: "", syncId: "", password: "" }));
  const [configOpen, setConfigOpen] = useState(false);
  const configRef = useRef(config); configRef.current = config;

  const notify = (message) => { setToast(message); window.setTimeout(() => setToast(""), 2300); };
  const update = (recipe) => setState((current) => ({ ...recipe(current), syncUpdatedAt: new Date().toISOString(), mobileSyncEnabled: true }));

  useEffect(() => {
    let local = normalize(readJson(stateKey, readJson(backupKey, emptyState)));
    setState(local); setLoaded(true);
    const initialize = async () => {
      if (!validConfig(configRef.current)) return;
      setSyncStatus("同步中");
      try {
        const remote = await pullRemote(configRef.current);
        if (remote && (remote.syncUpdatedAt > local.syncUpdatedAt || (!hasContent(local) && hasContent(remote)))) {
          local = remote; setState(remote); saveLocalSafely(remote);
        } else if (hasContent(local)) await pushRemote(local, configRef.current);
        setSyncStatus("已加密同步");
      } catch { setSyncStatus("离线，本地已保存"); }
    };
    void initialize();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { saveLocalSafely(state); setSyncStatus(validConfig(configRef.current) ? "等待同步" : "本地已保存"); }
    catch { setSyncStatus("本地空间不足"); notify("本地保存失败，请立即导出备份"); return; }
    if (!validConfig(configRef.current)) return;
    const timer = window.setTimeout(async () => {
      setSyncStatus("同步中");
      try { await pushRemote(state, configRef.current); setSyncStatus("已加密同步"); }
      catch { setSyncStatus("离线，本地已保存"); }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [state, loaded]);

  useEffect(() => {
    if (!loaded || !validConfig(config)) return;
    const timer = window.setInterval(async () => {
      try {
        const remote = await pullRemote(configRef.current);
        if (remote?.syncUpdatedAt > stateRef.current.syncUpdatedAt) setState(remote);
      } catch { /* 本地副本继续可用 */ }
    }, 30000);
    return () => window.clearInterval(timer);
  }, [loaded, config]);

  const todayTasks = useMemo(() => state.tasks.filter((task) => (task.dueDate || dateKey()) === dateKey()), [state.tasks]);
  const selectedTasks = useMemo(() => state.tasks.filter((task) => (task.dueDate || dateKey()) === selectedDate), [state.tasks, selectedDate]);
  const completed = todayTasks.filter((task) => task.done).length;
  const favorites = state.papers.filter((paper) => paper.favorite);

  function saveTask() {
    if (!taskEditor?.title.trim()) return;
    update((current) => ({ ...current, tasks: taskEditor.id
      ? current.tasks.map((task) => task.id === taskEditor.id ? { ...task, ...taskEditor, title: taskEditor.title.trim() } : task)
      : [...current.tasks, { ...taskEditor, id: uid("task"), title: taskEditor.title.trim(), done: false, subtasks: [] }] }));
    setTaskEditor(null); notify("任务已保存");
  }
  function toggleTask(id) { update((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === id ? { ...task, done: !task.done, completedAt: !task.done ? new Date().toISOString() : undefined } : task) })); }
  function removeTask(id) { if (confirm("删除这项任务？")) update((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== id) })); }
  async function addInventory(file) {
    if (!inventoryDraft.name.trim()) return;
    let storagePath;
    if (file && validConfig(configRef.current)) {
      try { storagePath = await uploadEncryptedFile(file, configRef.current, `${configRef.current.syncId}/images/${uid("image")}.bin`); }
      catch { notify("图片未同步，文字记录仍会保存"); }
    }
    update((current) => ({ ...current, inventory: [...current.inventory, { id: uid("item"), type: inventoryType, name: inventoryDraft.name.trim(), quantity: inventoryDraft.quantity, unit: inventoryDraft.unit, location: inventoryDraft.location, status: inventoryDraft.status || "记录正常", storagePath, imageMime: file?.type }] }));
    setInventoryDraft({ name: "", quantity: "", unit: "", location: "", status: "" }); notify("台账已保存");
  }
  async function addInvoices(files) {
    if (!files?.length) return;
    if (!validConfig(configRef.current)) { notify("请先配置 Supabase 同步，再上传 PDF"); return; }
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith(".pdf") || file.size > 20 * 1024 * 1024) { notify("仅支持 20 MB 以内 PDF"); continue; }
      try {
        const id = uid("invoice");
        const storagePath = await uploadEncryptedFile(file, configRef.current, `${configRef.current.syncId}/invoices/${id}.bin`);
        update((current) => ({ ...current, invoices: [...current.invoices, { id, name: file.name.replace(/\.pdf$/i, ""), fileName: file.name, storagePath, status: "未报", uploadedAt: new Date().toISOString(), size: file.size }] }));
      } catch { notify("PDF 上传失败，本地数据未被覆盖"); }
    }
  }
  async function openStoredFile(item, mime) {
    if (!item.storagePath || !validConfig(configRef.current)) return notify("文件未同步或尚未配置同步");
    try { window.open(await downloadEncryptedFile(item.storagePath, configRef.current, mime), "_blank"); }
    catch { notify("文件读取失败，请检查网络"); }
  }
  async function connectSync() {
    localStorage.setItem(configKey, JSON.stringify(config)); configRef.current = config;
    if (!validConfig(config)) return notify("请完整填写 Supabase 地址、密钥、同步码和密码");
    setSyncStatus("同步中");
    try {
      const remote = await pullRemote(config);
      const chosen = remote && remote.syncUpdatedAt > state.syncUpdatedAt ? remote : state;
      setState(chosen); saveLocalSafely(chosen); await pushRemote(chosen, config);
      setSyncStatus("已加密同步"); setConfigOpen(false); notify("同步连接成功");
    } catch (error) { setSyncStatus("连接失败，本地已保存"); notify(error.message || "同步连接失败"); }
  }
  function exportBackup() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), state }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `科研工作台手机备份-${dateKey()}.json`; a.click(); URL.revokeObjectURL(a.href);
  }

  const title = tab === "today" ? "今日工作台" : tab === "calendar" ? "日历" : tab === "inventory" ? "实验室台账" : tab === "invoices" ? "发票管理" : "习惯与收藏";
  return <main className="app">
    <header className="header"><div><small>科研工作台 · iPhone</small><h1>{title}</h1></div><button className="sync" onClick={() => setConfigOpen(true)}><i className={syncStatus === "已加密同步" ? "online" : ""} />{syncStatus}</button></header>

    {tab === "today" && <div className="content"><section className="todayHero"><div><span>今日进度</span><strong>{completed}<small> / {todayTasks.length}</small></strong></div><p>{state.dailyQuote}</p></section><div className="quadrants">{quadrants.map((quadrant) => { const tasks = todayTasks.filter((task) => task.quadrant === quadrant.id && !task.done); return <section key={quadrant.id} className="quadrant"><div className="quadrantHead"><i style={{ background: quadrant.color }} /><div><strong>{quadrant.label}</strong><small>{quadrant.hint} · {tasks.length} 项</small></div><button onClick={() => setTaskEditor({ title: "", duration: "30 分钟", quadrant: quadrant.id, dueDate: dateKey() })}>＋</button></div>{tasks.map((task) => <article className="task" key={task.id}><button className="check" onClick={() => toggleTask(task.id)} /><button className="taskCopy" onClick={() => setTaskEditor({ id: task.id, title: task.title, duration: task.duration, quadrant: task.quadrant, dueDate: task.dueDate || dateKey() })}><strong>{task.title}</strong><small>{task.duration} · {task.subtasks.length} 个小任务</small></button><button className="delete" onClick={() => removeTask(task.id)}>×</button></article>)}{!tasks.length && <p className="empty">暂无任务</p>}</section>; })}</div>{todayTasks.some((task) => task.done) && <section className="completed"><h2>已完成任务</h2>{todayTasks.filter((task) => task.done).map((task) => <article key={task.id}><button onClick={() => toggleTask(task.id)}>✓</button><span>{task.title}</span><button onClick={() => removeTask(task.id)}>×</button></article>)}</section>}</div>}

    {tab === "calendar" && <div className="content"><section className="datePicker"><label>选择日期<input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label><button onClick={() => setTaskEditor({ title: "", duration: "30 分钟", quadrant: "urgent-important", dueDate: selectedDate })}>＋ 添加任务</button></section><section className="dayList"><h2>{new Date(`${selectedDate}T12:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</h2>{selectedTasks.map((task) => <article key={task.id} className={task.done ? "done" : ""}><button className="check" onClick={() => toggleTask(task.id)} /><button className="taskCopy" onClick={() => setTaskEditor({ id: task.id, title: task.title, duration: task.duration, quadrant: task.quadrant, dueDate: task.dueDate || selectedDate })}><strong>{task.title}</strong><small>{quadrants.find((item) => item.id === task.quadrant)?.label} · {task.duration}</small></button><button className="delete" onClick={() => removeTask(task.id)}>×</button></article>)}{!selectedTasks.length && <p className="emptyLarge">这一天还没有任务</p>}</section></div>}

    {tab === "inventory" && <div className="content"><div className="segments">{["试剂", "动物", "冰箱", "切片"].map((type) => <button className={inventoryType === type ? "active" : ""} key={type} onClick={() => setInventoryType(type)}>{type}</button>)}</div><section className="formCard"><input value={inventoryDraft.name} onChange={(e) => setInventoryDraft({ ...inventoryDraft, name: e.target.value })} placeholder={`${inventoryType}名称 *`} /><div><input value={inventoryDraft.quantity} onChange={(e) => setInventoryDraft({ ...inventoryDraft, quantity: e.target.value })} placeholder="数量" /><input value={inventoryDraft.unit} onChange={(e) => setInventoryDraft({ ...inventoryDraft, unit: e.target.value })} placeholder="单位" /></div><input value={inventoryDraft.location} onChange={(e) => setInventoryDraft({ ...inventoryDraft, location: e.target.value })} placeholder="位置" /><input value={inventoryDraft.status} onChange={(e) => setInventoryDraft({ ...inventoryDraft, status: e.target.value })} placeholder="自定义状态" /><label className="fileButton">📷 图片（可选）<input id="inventory-image" type="file" accept="image/*" /></label><button onClick={() => { const input = document.querySelector("#inventory-image"); void addInventory(input?.files?.[0]); if (input) input.value = ""; }}>保存台账</button></section><section className="ledger">{state.inventory.filter((item) => item.type === inventoryType).map((item) => <article key={item.id}><button className="thumb" onClick={() => item.storagePath && openStoredFile(item, item.imageMime)}>{item.storagePath ? "📷" : inventoryType === "动物" ? "🐭" : inventoryType === "冰箱" ? "❄️" : inventoryType === "切片" ? "🔬" : "🧪"}</button><div><strong>{item.name}</strong><small>{item.quantity}{item.unit ? ` ${item.unit}` : ""} · {item.location || "未设位置"}</small><em>{item.status}</em></div><button onClick={() => update((current) => ({ ...current, inventory: current.inventory.filter((entry) => entry.id !== item.id) }))}>×</button></article>)}{!state.inventory.some((item) => item.type === inventoryType) && <p className="emptyLarge">暂无{inventoryType}记录</p>}</section></div>}

    {tab === "invoices" && <div className="content"><label className="pdfDrop">📄 选择或拖入 PDF<input type="file" accept="application/pdf,.pdf" multiple onChange={(event) => void addInvoices(event.target.files)} /></label><div className="invoiceStatuses">{["未报", "打印入库单", "完成"].map((status) => <section key={status}><h2>{status}<b>{state.invoices.filter((item) => item.status === status).length}</b></h2>{state.invoices.filter((item) => item.status === status).map((invoice) => <article key={invoice.id}><button className="fileLink" onClick={() => openStoredFile(invoice, "application/pdf")}><strong>{invoice.name}</strong><small>{(invoice.size / 1024 / 1024).toFixed(1)} MB</small></button><select value={invoice.status} onChange={(e) => update((current) => ({ ...current, invoices: current.invoices.map((item) => item.id === invoice.id ? { ...item, status: e.target.value } : item) }))}><option>未报</option><option>打印入库单</option><option>完成</option></select><button onClick={() => update((current) => ({ ...current, invoices: current.invoices.filter((item) => item.id !== invoice.id) }))}>删除</button></article>)}</section>)}</div></div>}

    {tab === "more" && <div className="content"><section className="moreCard"><h2>习惯养成</h2><div className="habitAdder"><input value={habitName} onChange={(e) => setHabitName(e.target.value)} placeholder="新习惯名称" /><button onClick={() => { if (!habitName.trim()) return; update((current) => ({ ...current, habits: [...current.habits, { id: uid("habit"), name: habitName.trim(), cadence: "daily", target: 1, completions: [], icon: "🌱" }] })); setHabitName(""); }}>添加</button></div>{state.habits.map((habit) => { const todayCount = habit.completions.filter((stamp) => stamp.slice(0, 10) === dateKey()).length; return <article className="habit" key={habit.id}><span>{habit.icon}</span><div><strong>{habit.name}</strong><small>今日 {todayCount} / {habit.target}</small></div><button onClick={() => update((current) => ({ ...current, habits: current.habits.map((item) => item.id === habit.id ? { ...item, completions: [...item.completions, new Date().toISOString()] } : item) }))}>＋1</button></article>; })}</section><section className="moreCard"><h2>文献收藏</h2>{favorites.map((paper) => <article className="savedPaper" key={paper.id}><a href={paper.url} target="_blank" rel="noreferrer"><strong>{paper.titleZh || paper.title}</strong><small>{paper.journal} · IF {paper.impact}</small></a><button onClick={() => update((current) => ({ ...current, papers: current.papers.map((item) => item.id === paper.id ? { ...item, favorite: false } : item) }))}>取消收藏</button></article>)}{!favorites.length && <p className="emptyLarge">电脑端收藏的文献会显示在这里</p>}</section><section className="moreCard settingsCard"><h2>数据与同步</h2><p>手机始终保留本地副本；云端只保存加密后的允许同步内容。</p><button onClick={() => setConfigOpen(true)}>设置加密同步</button><button className="secondary" onClick={exportBackup}>导出手机备份</button></section></div>}

    <nav className="nav">{[{ id: "today", icon: "🏠", label: "工作台" }, { id: "calendar", icon: "📅", label: "日历" }, { id: "inventory", icon: "🧪", label: "台账" }, { id: "invoices", icon: "🧾", label: "发票" }, { id: "more", icon: "🌱", label: "更多" }].map((item) => <button className={tab === item.id ? "active" : ""} key={item.id} onClick={() => setTab(item.id)}><span>{item.icon}</span><small>{item.label}</small></button>)}</nav>

    {taskEditor && <div className="modal"><section><h2>{taskEditor.id ? "修改任务" : "添加任务"}</h2><input autoFocus value={taskEditor.title} onChange={(e) => setTaskEditor({ ...taskEditor, title: e.target.value })} placeholder="任务内容" /><input type="date" value={taskEditor.dueDate} onChange={(e) => setTaskEditor({ ...taskEditor, dueDate: e.target.value })} /><select value={taskEditor.quadrant} onChange={(e) => setTaskEditor({ ...taskEditor, quadrant: e.target.value })}>{quadrants.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><input value={taskEditor.duration} onChange={(e) => setTaskEditor({ ...taskEditor, duration: e.target.value })} placeholder="预计时长" /><div><button onClick={() => setTaskEditor(null)}>取消</button><button onClick={saveTask}>保存</button></div></section></div>}

    {configOpen && <div className="modal"><section className="syncModal"><h2>加密同步设置</h2><p>配置只保存在本机。同步密码不会上传。</p><input value={config.url} onChange={(e) => setConfig({ ...config, url: e.target.value.trim() })} placeholder="Supabase Project URL" /><input value={config.anonKey} onChange={(e) => setConfig({ ...config, anonKey: e.target.value.trim() })} placeholder="Supabase anon key" /><input value={config.syncId} onChange={(e) => setConfig({ ...config, syncId: e.target.value.trim() })} placeholder="同步码（电脑与手机一致）" /><input type="password" value={config.password} onChange={(e) => setConfig({ ...config, password: e.target.value })} placeholder="加密密码（至少 8 位）" /><button className="generate" onClick={() => setConfig({ ...config, syncId: crypto.randomUUID() })}>生成同步码</button><div><button onClick={() => setConfigOpen(false)}>取消</button><button onClick={() => void connectSync()}>连接并同步</button></div></section></div>}
    {toast && <div className="toast">{toast}</div>}
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
