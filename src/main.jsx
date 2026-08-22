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
const inventoryTypes = ["试剂", "动物", "冰箱", "切片"];
const freezerZones = ["4℃", "-20℃", "-80℃"];
const emptyState = {
  tasks: [], inventory: [], habits: [], papers: [], keywords: [], radarTime: "08:00", paperBatch: 0,
  petName: "小咪", dailyQuote: "把复杂的问题拆成今天能推进的一小步。", dailyQuoteDate: "", dailyQuoteIndex: 0,
  dailyEnergyDecay: true, lastEnergyDecayDate: "", petEnergy: 50, interactionTokens: 0,
  taskReminderEnabled: false, syncUpdatedAt: "", mobileSyncEnabled: true,
};
const stateKey = "xiaomi-mobile-workbench-v2";
const backupKey = `${stateKey}-backup`;
const configKey = "xiaomi-mobile-sync-config-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const nameCollator = new Intl.Collator(["zh-CN-u-co-pinyin", "en"], { numeric: true, sensitivity: "base" });

function uid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
function dateKey(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function normalize(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...emptyState,
    tasks: Array.isArray(source.tasks) ? source.tasks.map((task) => ({ ...task, subtasks: Array.isArray(task.subtasks) ? task.subtasks : [] })) : [],
    inventory: Array.isArray(source.inventory) ? source.inventory : [],
    habits: Array.isArray(source.habits) ? source.habits.map((habit) => ({ ...habit, target: Math.max(1, Number(habit.target) || 1), completions: Array.isArray(habit.completions) ? habit.completions : [] })) : [],
    papers: Array.isArray(source.papers) ? source.papers : [],
    keywords: Array.isArray(source.keywords) ? source.keywords : [],
    radarTime: source.radarTime || emptyState.radarTime, paperBatch: Number(source.paperBatch) || 0,
    petName: source.petName || emptyState.petName, dailyQuote: source.dailyQuote || emptyState.dailyQuote,
    dailyQuoteDate: source.dailyQuoteDate || "", dailyQuoteIndex: Number(source.dailyQuoteIndex) || 0,
    dailyEnergyDecay: source.dailyEnergyDecay !== false, lastEnergyDecayDate: source.lastEnergyDecayDate || "",
    petEnergy: Number.isFinite(Number(source.petEnergy)) ? Number(source.petEnergy) : 50,
    interactionTokens: Number(source.interactionTokens) || 0, taskReminderEnabled: Boolean(source.taskReminderEnabled),
    syncUpdatedAt: source.syncUpdatedAt || "", mobileSyncEnabled: source.mobileSyncEnabled !== false,
  };
}
function hasContent(value) { return value.tasks.length || value.inventory.length || value.habits.length || value.papers.some((paper) => paper.favorite); }
function readJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch { return fallback; } }
function saveLocalSafely(value) {
  const serialized = JSON.stringify(normalize(value)); JSON.parse(serialized);
  const current = localStorage.getItem(stateKey); if (current) localStorage.setItem(backupKey, current);
  localStorage.setItem(stateKey, serialized);
  if (localStorage.getItem(stateKey) !== serialized) throw new Error("本地保存校验失败");
}
function calendarDays(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const first = new Date(year, month - 1, 1); const start = new Date(year, month - 1, 1 - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return { key: dateKey(date), day: date.getDate(), outside: date.getMonth() !== month - 1 }; });
}
function isCurrentHabitStamp(stamp, cadence) {
  const now = new Date();
  if (cadence === "daily") return stamp.slice(0, 10) === dateKey(now);
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const completed = new Date(stamp); return completed >= monday && completed <= now;
}
function currentHabitCount(habit) { return habit.completions.filter((stamp) => isCurrentHabitStamp(stamp, habit.cadence)).length; }
function inventoryHealth(item) {
  if (item.expiry) { const days = Math.ceil((new Date(`${item.expiry}T23:59:59`).getTime() - Date.now()) / 86400000); if (days < 0) return "已过期"; if (days <= 30) return `临近到期 · ${days} 天`; }
  if (item.quantity && Number(item.quantity) <= 1) return "库存偏低";
  return item.status || "记录正常";
}
function bytesToBase64(bytes) { let text = ""; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); }
function base64ToBytes(value) { const text = atob(value); return Uint8Array.from(text, (char) => char.charCodeAt(0)); }
async function encryptionKey(password, syncId) { const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]); return crypto.subtle.deriveKey({ name: "PBKDF2", salt: encoder.encode(`科研工作台:${syncId}`), iterations: 180000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); }
async function encryptBytes(bytes, config) { const key = await encryptionKey(config.password, config.syncId); const iv = crypto.getRandomValues(new Uint8Array(12)); const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes)); const packed = new Uint8Array(iv.length + encrypted.length); packed.set(iv); packed.set(encrypted, iv.length); return packed; }
async function decryptBytes(bytes, config) { const key = await encryptionKey(config.password, config.syncId); return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12))); }
async function encryptState(value, config) { return bytesToBase64(await encryptBytes(encoder.encode(JSON.stringify(normalize(value))), config)); }
async function decryptState(value, config) { return normalize(JSON.parse(decoder.decode(await decryptBytes(base64ToBytes(value), config)))); }
function validConfig(config) { return /^https:\/\/.+\.supabase\.co$/i.test(config.url || "") && (config.anonKey || "").length > 40 && (config.syncId || "").length >= 8 && (config.password || "").length >= 8; }
function headers(config, extras = {}) { return { apikey: config.anonKey, Authorization: `Bearer ${config.anonKey}`, ...extras }; }
async function pullRemote(config) { const response = await fetch(`${config.url}/rest/v1/workspace_state?id=eq.${encodeURIComponent(config.syncId)}&select=payload,updated_at`, { headers: headers(config), cache: "no-store" }); if (!response.ok) throw new Error(`同步读取失败 ${response.status}`); const rows = await response.json(); return rows[0]?.payload ? decryptState(rows[0].payload, config) : null; }
async function pushRemote(value, config) { const payload = await encryptState(value, config); const response = await fetch(`${config.url}/rest/v1/workspace_state?on_conflict=id`, { method: "POST", headers: headers(config, { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify({ id: config.syncId, payload, updated_at: value.syncUpdatedAt || new Date().toISOString() }) }); if (!response.ok) throw new Error(`同步保存失败 ${response.status}`); }
async function uploadEncryptedFile(file, config, path) { const encrypted = await encryptBytes(new Uint8Array(await file.arrayBuffer()), config); const response = await fetch(`${config.url}/storage/v1/object/workbench-files/${path}`, { method: "POST", headers: headers(config, { "Content-Type": "application/octet-stream", "x-upsert": "true" }), body: encrypted }); if (!response.ok) throw new Error(`图片上传失败 ${response.status}`); return path; }
async function downloadEncryptedFile(path, config, mime) { const response = await fetch(`${config.url}/storage/v1/object/workbench-files/${path}`, { headers: headers(config) }); if (!response.ok) throw new Error(`图片读取失败 ${response.status}`); const clear = await decryptBytes(new Uint8Array(await response.arrayBuffer()), config); return URL.createObjectURL(new Blob([clear], { type: mime || "application/octet-stream" })); }

function App() {
  const [tab, setTab] = useState("today");
  const [state, setState] = useState(emptyState);
  const stateRef = useRef(state); stateRef.current = state;
  const [loaded, setLoaded] = useState(false);
  const [syncStatus, setSyncStatus] = useState("本地已保存");
  const [calendarMonth, setCalendarMonth] = useState(dateKey().slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(dateKey());
  const [inventoryType, setInventoryType] = useState("试剂");
  const [freezerZone, setFreezerZone] = useState("4℃");
  const [inventoryQuery, setInventoryQuery] = useState("");
  const [taskEditor, setTaskEditor] = useState(null);
  const blankInventory = { name: "", specification: "", quantity: "", unit: "", location: "", expiry: "", status: "", researchProject: "", indicator: "", group: "" };
  const [inventoryDraft, setInventoryDraft] = useState(blankInventory);
  const [habitDraft, setHabitDraft] = useState({ name: "", cadence: "daily", target: 1 });
  const [toast, setToast] = useState("");
  const [config, setConfig] = useState(() => readJson(configKey, { url: "", anonKey: "", syncId: "", password: "" }));
  const [configOpen, setConfigOpen] = useState(false);
  const configRef = useRef(config); configRef.current = config;
  const notify = (message) => { setToast(message); window.setTimeout(() => setToast(""), 2300); };
  const update = (recipe) => setState((current) => ({ ...recipe(current), syncUpdatedAt: new Date().toISOString(), mobileSyncEnabled: true }));

  useEffect(() => {
    let local = normalize(readJson(stateKey, readJson(backupKey, emptyState))); const today = dateKey();
    local.tasks = local.tasks.map((task) => !task.done && task.dueDate && task.dueDate < today ? { ...task, dueDate: today, reminderSent: false } : task);
    setState(local); setLoaded(true);
    const initialize = async () => {
      if (!validConfig(configRef.current)) return; setSyncStatus("同步中");
      try { const remote = await pullRemote(configRef.current); if (remote && (remote.syncUpdatedAt > local.syncUpdatedAt || (!hasContent(local) && hasContent(remote)))) { local = remote; setState(remote); saveLocalSafely(remote); } else if (hasContent(local)) await pushRemote(local, configRef.current); setSyncStatus("已加密同步"); } catch { setSyncStatus("离线，本地已保存"); }
    };
    void initialize(); if ("serviceWorker" in navigator) navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try { saveLocalSafely(state); setSyncStatus(validConfig(configRef.current) ? "等待同步" : "本地已保存"); } catch { setSyncStatus("本地空间不足"); notify("本地保存失败，请立即导出备份"); return; }
    if (!validConfig(configRef.current)) return;
    const timer = window.setTimeout(async () => { setSyncStatus("同步中"); try { await pushRemote(state, configRef.current); setSyncStatus("已加密同步"); } catch { setSyncStatus("离线，本地已保存"); } }, 900);
    return () => window.clearTimeout(timer);
  }, [state, loaded]);
  useEffect(() => {
    if (!loaded || !validConfig(config)) return;
    const timer = window.setInterval(async () => { try { const remote = await pullRemote(configRef.current); if (remote?.syncUpdatedAt > stateRef.current.syncUpdatedAt) setState(remote); } catch { /* 本地副本继续可用 */ } }, 30000);
    return () => window.clearInterval(timer);
  }, [loaded, config]);
  useEffect(() => {
    if (!loaded || !state.taskReminderEnabled) return;
    const check = () => {
      const now = new Date(); if (now.getHours() < 10) return;
      const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); const key = dateKey(tomorrow);
      const pending = stateRef.current.tasks.filter((task) => task.dueDate === key && !task.done && !task.reminderSent); if (!pending.length) return;
      notify(`明日任务：${pending[0].title}${pending.length > 1 ? ` 等 ${pending.length} 项` : ""}`);
      if ("Notification" in window && Notification.permission === "granted") new Notification("科研工作台 · 明日任务", { body: pending.map((item) => item.title).join("、") });
      update((current) => ({ ...current, tasks: current.tasks.map((task) => task.dueDate === key && !task.done ? { ...task, reminderSent: true } : task) }));
    };
    check(); const timer = window.setInterval(check, 60000); return () => window.clearInterval(timer);
  }, [loaded, state.taskReminderEnabled]);

  const todayTasks = useMemo(() => state.tasks.filter((task) => (task.dueDate || dateKey()) === dateKey()), [state.tasks]);
  const selectedTasks = useMemo(() => state.tasks.filter((task) => task.dueDate === selectedDate), [state.tasks, selectedDate]);
  const monthCells = useMemo(() => calendarDays(calendarMonth), [calendarMonth]);
  const completed = todayTasks.filter((task) => task.done).length;
  const favorites = state.papers.filter((paper) => paper.favorite);
  const visibleInventory = useMemo(() => state.inventory.filter((item) => item.type === inventoryType && (inventoryType !== "冰箱" || item.category === freezerZone) && `${item.name} ${item.category} ${item.location} ${item.status} ${item.researchProject} ${item.indicator} ${item.group}`.toLowerCase().includes(inventoryQuery.trim().toLowerCase())).sort((a, b) => inventoryType === "试剂" ? nameCollator.compare(a.name, b.name) : 0), [state.inventory, inventoryType, freezerZone, inventoryQuery]);

  function saveTask() { if (!taskEditor?.title.trim()) return; update((current) => ({ ...current, tasks: taskEditor.id ? current.tasks.map((task) => task.id === taskEditor.id ? { ...task, ...taskEditor, title: taskEditor.title.trim() } : task) : [...current.tasks, { ...taskEditor, id: uid("task"), title: taskEditor.title.trim(), done: false, subtasks: [] }] })); setTaskEditor(null); notify("任务已保存"); }
  function toggleTask(id) { update((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === id ? { ...task, done: !task.done, completedAt: !task.done ? new Date().toISOString() : undefined } : task) })); }
  function removeTask(id) { if (confirm("删除这项任务？")) update((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== id) })); }
  function shiftMonth(amount) { const [year, month] = calendarMonth.split("-").map(Number); const next = new Date(year, month - 1 + amount, 1); setCalendarMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`); }
  async function enableReminders() { if (!("Notification" in window)) { update((current) => ({ ...current, taskReminderEnabled: true })); return notify("已开启站内提醒"); } const permission = await Notification.requestPermission(); update((current) => ({ ...current, taskReminderEnabled: permission === "granted" })); notify(permission === "granted" ? "已开启提前一天 10:00 提醒" : "未获得通知权限"); }

  async function addInventory(file) {
    const isSlice = inventoryType === "切片"; const name = isSlice ? `${inventoryDraft.indicator.trim() || "未命名指标"}切片` : inventoryDraft.name.trim();
    if ((isSlice && (!inventoryDraft.researchProject.trim() || !inventoryDraft.indicator.trim())) || (!isSlice && !name)) return notify(isSlice ? "请填写所属课题和指标" : `请填写${inventoryType}名称`);
    let storagePath;
    if (file && validConfig(configRef.current)) { try { storagePath = await uploadEncryptedFile(file, configRef.current, `${configRef.current.syncId}/images/${uid("image")}.bin`); } catch { notify("图片未同步，文字记录仍会保存"); } }
    const category = inventoryType === "冰箱" ? freezerZone : isSlice ? inventoryDraft.group.trim() || "未分组" : inventoryType;
    update((current) => ({ ...current, inventory: [...current.inventory, { id: uid("item"), type: inventoryType, category, detail: [inventoryDraft.specification, inventoryDraft.quantity && `${inventoryDraft.quantity} ${inventoryDraft.unit}`, inventoryDraft.location].filter(Boolean).join(" · "), ...inventoryDraft, name, status: inventoryDraft.status.trim() || "记录正常", storagePath, imageMime: file?.type }] }));
    setInventoryDraft(blankInventory); const input = document.querySelector("#inventory-image"); if (input) input.value = ""; notify("台账已保存");
  }
  function editStatus(item) { const status = prompt("修改状态", item.status || "记录正常"); if (status?.trim()) update((current) => ({ ...current, inventory: current.inventory.map((entry) => entry.id === item.id ? { ...entry, status: status.trim() } : entry) })); }
  function deleteInventory(id) { if (confirm("删除这条台账？")) update((current) => ({ ...current, inventory: current.inventory.filter((entry) => entry.id !== id) })); }
  async function openStoredImage(item) { if (item.image) return window.open(item.image, "_blank", "noopener,noreferrer"); if (!item.storagePath || !validConfig(configRef.current)) return notify("图片未同步或尚未配置同步"); try { window.open(await downloadEncryptedFile(item.storagePath, configRef.current, item.imageMime || "image/jpeg"), "_blank"); } catch { notify("图片读取失败，请检查网络"); } }
  function addHabit() { if (!habitDraft.name.trim()) return; update((current) => ({ ...current, habits: [...current.habits, { id: uid("habit"), name: habitDraft.name.trim(), cadence: habitDraft.cadence, target: Math.max(1, Number(habitDraft.target) || 1), completions: [], icon: ["🌱", "📖", "🧪", "☕", "🎯"][current.habits.length % 5] }] })); setHabitDraft({ name: "", cadence: "daily", target: 1 }); }
  function completeHabit(id) { update((current) => ({ ...current, habits: current.habits.map((habit) => habit.id === id ? { ...habit, completions: [...habit.completions, new Date().toISOString()] } : habit) })); }
  function undoHabit(id) { update((current) => ({ ...current, habits: current.habits.map((habit) => { if (habit.id !== id) return habit; const last = habit.completions.map((stamp, index) => isCurrentHabitStamp(stamp, habit.cadence) ? index : -1).filter((index) => index >= 0).at(-1); return last === undefined ? habit : { ...habit, completions: habit.completions.filter((_, index) => index !== last) }; }) })); }
  function updateHabitTarget(id, target) { update((current) => ({ ...current, habits: current.habits.map((habit) => habit.id === id ? { ...habit, target: Math.max(1, Number(target) || 1) } : habit) })); }
  function deleteHabit(id) { if (confirm("删除这个习惯？")) update((current) => ({ ...current, habits: current.habits.filter((habit) => habit.id !== id) })); }
  async function connectSync() { localStorage.setItem(configKey, JSON.stringify(config)); configRef.current = config; if (!validConfig(config)) return notify("请完整填写 Supabase 地址、密钥、同步码和密码"); setSyncStatus("同步中"); try { const remote = await pullRemote(config); const chosen = remote && remote.syncUpdatedAt > state.syncUpdatedAt ? remote : state; setState(chosen); saveLocalSafely(chosen); await pushRemote(chosen, config); setSyncStatus("已加密同步"); setConfigOpen(false); notify("同步连接成功"); } catch (error) { setSyncStatus("连接失败，本地已保存"); notify(error.message || "同步连接失败"); } }
  function exportBackup() { const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), state }, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `科研工作台手机备份-${dateKey()}.json`; a.click(); URL.revokeObjectURL(a.href); }

  const title = tab === "today" ? "今日工作台" : tab === "calendar" ? "日历" : tab === "inventory" ? "实验室台账" : tab === "habits" ? "习惯养成" : "文献与设置";
  return <main className="app">
    <header className="header"><div><small>科研工作台 · iPhone</small><h1>{title}</h1></div><button className="sync" onClick={() => setConfigOpen(true)}><i className={syncStatus === "已加密同步" ? "online" : ""} />{syncStatus}</button></header>
    {tab === "today" && <div className="content"><section className="todayHero"><div><span>今日进度</span><strong>{completed}<small> / {todayTasks.length}</small></strong></div><p>{state.dailyQuote}</p></section><div className="quadrants">{quadrants.map((quadrant) => { const tasks = todayTasks.filter((task) => task.quadrant === quadrant.id && !task.done); return <section key={quadrant.id} className="quadrant"><div className="quadrantHead"><i style={{ background: quadrant.color }} /><div><strong>{quadrant.label}</strong><small>{quadrant.hint} · {tasks.length} 项</small></div><button onClick={() => setTaskEditor({ title: "", duration: "30 分钟", quadrant: quadrant.id, dueDate: dateKey() })}>＋</button></div>{tasks.map((task) => <article className="task" key={task.id}><button className="check" onClick={() => toggleTask(task.id)} /><button className="taskCopy" onClick={() => setTaskEditor({ id: task.id, title: task.title, duration: task.duration, quadrant: task.quadrant, dueDate: task.dueDate || dateKey() })}><strong>{task.title}</strong><small>{task.duration} · {task.subtasks.length} 个小任务</small></button><button className="delete" onClick={() => removeTask(task.id)}>×</button></article>)}{!tasks.length && <p className="empty">暂无任务</p>}</section>; })}</div>{todayTasks.some((task) => task.done) && <section className="completed"><h2>已完成任务</h2>{todayTasks.filter((task) => task.done).map((task) => <article key={task.id}><button onClick={() => toggleTask(task.id)}>✓</button><span>{task.title}</span><button onClick={() => removeTask(task.id)}>×</button></article>)}</section>}</div>}
    {tab === "calendar" && <div className="content"><section className="calendarToolbar"><div><button onClick={() => shiftMonth(-1)}>‹</button><strong>{calendarMonth.split("-")[0]}年 {Number(calendarMonth.split("-")[1])}月</strong><button onClick={() => shiftMonth(1)}>›</button></div><button onClick={() => { setCalendarMonth(dateKey().slice(0, 7)); setSelectedDate(dateKey()); }}>今天</button></section><button className={`reminderButton ${state.taskReminderEnabled ? "on" : ""}`} onClick={() => void enableReminders()}><span>🔔</span><div><strong>提前一天 10:00 提醒</strong><small>{state.taskReminderEnabled ? "已开启" : "点击开启"}</small></div></button><section className="mobileMonth"><div className="mobileWeekdays">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>周{day}</span>)}</div><div className="mobileMonthGrid">{monthCells.map((cell) => { const tasks = state.tasks.filter((task) => task.dueDate === cell.key); return <button key={cell.key} className={`${cell.outside ? "outside" : ""} ${cell.key === selectedDate ? "selected" : ""} ${cell.key === dateKey() ? "today" : ""}`} onClick={() => { setSelectedDate(cell.key); if (cell.outside) setCalendarMonth(cell.key.slice(0, 7)); }}><b>{cell.day}</b><i>{tasks.length || ""}</i></button>; })}</div></section><section className="dayList"><div className="dayListHead"><h2>{new Date(`${selectedDate}T12:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</h2><button onClick={() => setTaskEditor({ title: "", duration: "30 分钟", quadrant: "urgent-important", dueDate: selectedDate })}>＋ 添加</button></div>{selectedTasks.map((task) => <article key={task.id} className={task.done ? "done" : ""}><button className="check" onClick={() => toggleTask(task.id)} /><button className="taskCopy" onClick={() => setTaskEditor({ id: task.id, title: task.title, duration: task.duration, quadrant: task.quadrant, dueDate: task.dueDate || selectedDate })}><strong>{task.title}</strong><small>{quadrants.find((item) => item.id === task.quadrant)?.label} · {task.duration} · {task.subtasks.length} 个小任务</small></button><button className="delete" onClick={() => removeTask(task.id)}>×</button></article>)}{!selectedTasks.length && <p className="emptyLarge">这一天还没有任务</p>}</section></div>}
    {tab === "inventory" && <div className="content"><div className="segments">{inventoryTypes.map((type) => <button className={inventoryType === type ? "active" : ""} key={type} onClick={() => { setInventoryType(type); setInventoryDraft(blankInventory); }}>{type}</button>)}</div>{inventoryType === "冰箱" && <div className="freezerSegments">{freezerZones.map((zone) => <button className={freezerZone === zone ? "active" : ""} key={zone} onClick={() => setFreezerZone(zone)}>{zone}</button>)}</div>}<div className="inventorySearch">🔎<input value={inventoryQuery} onChange={(event) => setInventoryQuery(event.target.value)} placeholder={`搜索${inventoryType}`} /></div><section className="formCard">{inventoryType === "切片" ? <><input value={inventoryDraft.researchProject} onChange={(e) => setInventoryDraft({ ...inventoryDraft, researchProject: e.target.value })} placeholder="所属课题 *" /><input value={inventoryDraft.indicator} onChange={(e) => setInventoryDraft({ ...inventoryDraft, indicator: e.target.value })} placeholder="指标 *" /><input value={inventoryDraft.group} onChange={(e) => setInventoryDraft({ ...inventoryDraft, group: e.target.value })} placeholder="分组" /><input value={inventoryDraft.quantity} onChange={(e) => setInventoryDraft({ ...inventoryDraft, quantity: e.target.value })} placeholder="数量，如：12张 / 3盒" /></> : <><input value={inventoryDraft.name} onChange={(e) => setInventoryDraft({ ...inventoryDraft, name: e.target.value })} placeholder={inventoryType === "试剂" ? "名称 *" : inventoryType === "动物" ? "品系 / 名称 *" : "物品名称 *"} /><input value={inventoryDraft.specification} onChange={(e) => setInventoryDraft({ ...inventoryDraft, specification: e.target.value })} placeholder={inventoryType === "试剂" ? "规格 / 浓度" : inventoryType === "动物" ? "周龄 / 性别" : "规格 / 批次"} /><div><input value={inventoryDraft.quantity} onChange={(e) => setInventoryDraft({ ...inventoryDraft, quantity: e.target.value })} placeholder="库存 / 数量" /><input value={inventoryDraft.unit} onChange={(e) => setInventoryDraft({ ...inventoryDraft, unit: e.target.value })} placeholder="单位" /></div><input value={inventoryDraft.location} onChange={(e) => setInventoryDraft({ ...inventoryDraft, location: e.target.value })} placeholder={inventoryType === "动物" ? "笼位 / 房间" : inventoryType === "冰箱" ? "层架 / 抽屉 / 盒号" : "存放位置"} />{inventoryType === "试剂" && <label className="dateField">有效期<input type="date" value={inventoryDraft.expiry} onChange={(e) => setInventoryDraft({ ...inventoryDraft, expiry: e.target.value })} /></label>}<input value={inventoryDraft.status} onChange={(e) => setInventoryDraft({ ...inventoryDraft, status: e.target.value })} placeholder="自定义状态" /></>}<label className="fileButton">📷 图片（可选）<input id="inventory-image" type="file" accept="image/*" /></label><button onClick={() => { const input = document.querySelector("#inventory-image"); void addInventory(input?.files?.[0]); }}>保存{inventoryType}</button></section><section className="ledger"><div className="ledgerTitle"><h2>{inventoryType}台账</h2><b>{visibleInventory.length}</b></div>{visibleInventory.map((item) => <article key={item.id}><button className="thumb" onClick={() => void openStoredImage(item)}>{item.image || item.storagePath ? "📷" : inventoryType === "动物" ? "🐭" : inventoryType === "冰箱" ? "❄️" : inventoryType === "切片" ? "🔬" : "🧪"}</button><div><strong>{inventoryType === "切片" ? item.indicator || item.name : item.name}</strong><small>{inventoryType === "切片" ? `${item.researchProject || "未设课题"} · ${item.group || "未分组"} · ${item.quantity || "未设数量"}` : `${item.specification || "未设规格"} · ${item.quantity || "—"}${item.unit ? ` ${item.unit}` : ""} · ${inventoryType === "冰箱" ? item.category : item.location || "未设位置"}`}</small><button className="statusPill" onClick={() => editStatus(item)}>{inventoryHealth(item)}</button></div><button onClick={() => deleteInventory(item.id)}>×</button></article>)}{!visibleInventory.length && <p className="emptyLarge">暂无{inventoryType}{inventoryType === "冰箱" ? `（${freezerZone}）` : ""}记录</p>}</section></div>}
    {tab === "habits" && <div className="content"><section className="habitHero"><div><span>🌱</span><div><strong>稳定胜过偶尔用力</strong><small>每天多次或每周多次都可设置</small></div></div><b>{state.habits.filter((habit) => currentHabitCount(habit) >= habit.target).length} / {state.habits.length}</b></section><section className="habitForm"><input value={habitDraft.name} onChange={(e) => setHabitDraft({ ...habitDraft, name: e.target.value })} placeholder="习惯名称" /><div><select value={habitDraft.cadence} onChange={(e) => setHabitDraft({ ...habitDraft, cadence: e.target.value })}><option value="daily">每天</option><option value="weekly">每周</option></select><label>目标 <input type="number" min="1" max="30" value={habitDraft.target} onChange={(e) => setHabitDraft({ ...habitDraft, target: Math.max(1, Number(e.target.value) || 1) })} /></label><button onClick={addHabit}>＋ 建立</button></div></section><div className="habitGrid">{state.habits.map((habit) => { const count = currentHabitCount(habit); const achieved = count >= habit.target; return <article className={`habitCard ${achieved ? "achieved" : ""}`} key={habit.id}><div className="habitTop"><span>{habit.icon}</span><div><strong>{habit.name}</strong><small>{habit.cadence === "daily" ? "今日" : "本周"} {count} / {habit.target}</small></div><button onClick={() => deleteHabit(habit.id)}>×</button></div><div className="habitBar"><i style={{ width: `${Math.min(100, count / habit.target * 100)}%` }} /></div><label className="targetEdit">目标次数<input type="number" min="1" max="30" value={habit.target} onChange={(e) => updateHabitTarget(habit.id, e.target.value)} /><span>{habit.cadence === "daily" ? "次 / 天" : "次 / 周"}</span></label><div className="habitActions"><button disabled={!count} onClick={() => undoHabit(habit.id)}>撤销一次</button><button onClick={() => completeHabit(habit.id)}>完成一次</button></div></article>; })}{!state.habits.length && <p className="emptyLarge">还没有习惯，先建立一个吧</p>}</div></div>}
    {tab === "more" && <div className="content"><section className="moreCard"><h2>文献收藏</h2>{favorites.map((paper) => <article className="savedPaper" key={paper.id}><a href={paper.url} target="_blank" rel="noreferrer"><strong>{paper.titleZh || paper.title}</strong><small>{paper.journal} · IF {paper.impact}</small></a><button onClick={() => update((current) => ({ ...current, papers: current.papers.map((item) => item.id === paper.id ? { ...item, favorite: false } : item) }))}>取消收藏</button></article>)}{!favorites.length && <p className="emptyLarge">电脑端收藏的文献会显示在这里</p>}</section><section className="moreCard settingsCard"><h2>数据与同步</h2><p>手机始终保留本地副本；云端只保存加密后的任务、日历、台账、习惯与文献收藏。科研项目、周报复盘和发票不会出现在手机端，也不会上传。</p><button onClick={() => setConfigOpen(true)}>设置加密同步</button><button className="secondary" onClick={exportBackup}>导出手机备份</button></section></div>}
    <nav className="nav">{[{ id: "today", icon: "🏠", label: "工作台" }, { id: "calendar", icon: "📅", label: "日历" }, { id: "inventory", icon: "🧪", label: "台账" }, { id: "habits", icon: "🌱", label: "习惯" }, { id: "more", icon: "⚙️", label: "更多" }].map((item) => <button className={tab === item.id ? "active" : ""} key={item.id} onClick={() => setTab(item.id)}><span>{item.icon}</span><small>{item.label}</small></button>)}</nav>
    {taskEditor && <div className="modal"><section><h2>{taskEditor.id ? "修改任务" : "添加任务"}</h2><input autoFocus value={taskEditor.title} onChange={(e) => setTaskEditor({ ...taskEditor, title: e.target.value })} placeholder="任务内容" /><input type="date" value={taskEditor.dueDate} onChange={(e) => setTaskEditor({ ...taskEditor, dueDate: e.target.value })} /><select value={taskEditor.quadrant} onChange={(e) => setTaskEditor({ ...taskEditor, quadrant: e.target.value })}>{quadrants.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><input value={taskEditor.duration} onChange={(e) => setTaskEditor({ ...taskEditor, duration: e.target.value })} placeholder="预计时长" /><div><button onClick={() => setTaskEditor(null)}>取消</button><button onClick={saveTask}>保存</button></div></section></div>}
    {configOpen && <div className="modal"><section className="syncModal"><h2>加密同步设置</h2><p>配置只保存在本机。同步密码不会上传。</p><input value={config.url} onChange={(e) => setConfig({ ...config, url: e.target.value.trim() })} placeholder="Supabase Project URL" /><input value={config.anonKey} onChange={(e) => setConfig({ ...config, anonKey: e.target.value.trim() })} placeholder="Supabase anon key" /><input value={config.syncId} onChange={(e) => setConfig({ ...config, syncId: e.target.value.trim() })} placeholder="同步码（电脑与手机一致）" /><input type="password" value={config.password} onChange={(e) => setConfig({ ...config, password: e.target.value })} placeholder="加密密码（至少 8 位）" /><button className="generate" onClick={() => setConfig({ ...config, syncId: crypto.randomUUID() })}>生成同步码</button><div><button onClick={() => setConfigOpen(false)}>取消</button><button onClick={() => void connectSync()}>连接并同步</button></div></section></div>}
    {toast && <div className="toast">{toast}</div>}
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
