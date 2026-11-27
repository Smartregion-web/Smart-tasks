import { Bot, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import { GoogleGenAI } from "@google/genai";
import pg from "pg";
import dotenv from "dotenv";
import express from "express";
import crypto from "crypto";
import { spawn } from "child_process";

dotenv.config();

// ═════════════════════════════ Конфиг ═════════════════════════════
const TZ = "Asia/Almaty";           // для вывода времени
const TZ_OFFSET_H = 5;              // UTC+5 (фиксированный)

// Модели Gemini: GEMINI_MODEL (можно списком через запятую), затем запасные.
// При 429 (лимит) / 503 (перегрузка) / 404 бот сам переключается на следующую модель,
// а «упавшая» модель получает паузу и не долбится повторно.
const MODEL_CANDIDATES = [
  ...new Set(
    [
      ...String(process.env.GEMINI_MODEL || "").split(","),
      ...String(process.env.GEMINI_FALLBACK_MODELS || "").split(","),
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]
      .map((s) => s.trim())
      .filter(Boolean)
  ),
];

// Необязательный запасной канал (бесплатный ключ на console.groq.com): текст + расшифровка голоса
const GROQ_LLM_MODEL = process.env.GROQ_LLM_MODEL || "llama-3.3-70b-versatile";
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";

// Голосовой брифинг (TTS)
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const TTS_VOICE = process.env.TTS_VOICE || "Kore";
const VOICE_BRIEF = String(process.env.VOICE_BRIEF || "on").toLowerCase() !== "off";

const PORT = process.env.PORT || 10000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || "https://oilan-tasks-bot.onrender.com";
const BOT_MODE = process.env.BOT_MODE || (process.env.RENDER_EXTERNAL_URL ? "webhook" : "polling");
const CEO_ID = String(process.env.CEO_TELEGRAM_ID);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET ||
  crypto.createHash("sha256").update(TOKEN || "").digest("hex").slice(0, 32);

const ESCALATION_HOURS = 2;   // через сколько часов просрочки — эскалация
const SPAWN_HOUR = 8;         // во сколько (Астана) создаются повторяющиеся задачи
const HTML = { parse_mode: "HTML" };
const COMPANY_NAME = process.env.COMPANY_NAME || "Smart Region";
const CEO_NAME = process.env.CEO_NAME || "Жандос";

const MEETING_SECONDS = Number(process.env.MEETING_SECONDS || 120);      // голосовое длиннее = «совещание»
const MEETING_TEXT_CHARS = Number(process.env.MEETING_TEXT_CHARS || 1200); // текст длиннее = «протокол»
const WORKLOAD_WARN = Number(process.env.WORKLOAD_WARN || 6);            // предупреждение о перегрузке
const MAX_INLINE_BYTES = 14 * 1024 * 1024;                               // лимит файла для Gemini inline

// Тихие часы: сотруднику сообщения приходят без звука (срочные — со звуком)
const QUIET_START = process.env.QUIET_START === undefined ? 22 : Number(process.env.QUIET_START);
const QUIET_END = process.env.QUIET_END === undefined ? 8 : Number(process.env.QUIET_END);
const QUIET_ON = Number.isFinite(QUIET_START) && Number.isFinite(QUIET_END) && QUIET_START !== QUIET_END;
const QUIET_WEEKENDS = String(process.env.QUIET_WEEKENDS || "off").toLowerCase() === "on";

// ═════════════════════════════ Хелперы ═════════════════════════════
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");
const fmt = (d) => new Date(d).toLocaleString("ru-RU", { timeZone: TZ });
const fmtDate = (d) => new Date(d).toLocaleDateString("ru-RU", { timeZone: TZ, day: "numeric", month: "long" });

const localToUtc = (y, mo, d, h = 0, mi = 0) =>
  new Date(Date.UTC(y, mo, d, h - TZ_OFFSET_H, mi));

function localParts(date = new Date()) {
  const s = new Date(date.getTime() + TZ_OFFSET_H * 3600000);
  return {
    y: s.getUTCFullYear(),
    mo: s.getUTCMonth(),
    d: s.getUTCDate(),
    h: s.getUTCHours(),
    mi: s.getUTCMinutes(),
    wd: ((s.getUTCDay() + 6) % 7) + 1, // 1=пн … 7=вс
  };
}

const todayKey = (date = new Date()) => {
  const p = localParts(date);
  return `${p.y}-${pad2(p.mo + 1)}-${pad2(p.d)}`;
};

function isQuiet(now = new Date()) {
  const p = localParts(now);
  if (QUIET_WEEKENDS && p.wd >= 6) return true;
  if (!QUIET_ON) return false;
  return QUIET_START > QUIET_END ? p.h >= QUIET_START || p.h < QUIET_END : p.h >= QUIET_START && p.h < QUIET_END;
}
// Ночью — без звука, кроме срочных задач
const quietExtra = (row) => (isQuiet() && row?.priority !== "urgent" ? { disable_notification: true } : {});

const isAway = (emp) => !!(emp?.away_until && new Date(emp.away_until).getTime() > Date.now());

const STATUS_RU = {
  pending: "ожидает",
  in_progress: "в работе",
  completed: "выполнена",
  cancelled: "отменена",
};

const PRIO_LABEL = { urgent: "🔥 Срочно", important: "⭐ Важно" };
const prioIcon = (t) => (t?.priority === "urgent" ? "🔥 " : t?.priority === "important" ? "⭐ " : "");

const WEEKDAYS_DAT = ["понедельникам", "вторникам", "средам", "четвергам", "пятницам", "субботам", "воскресеньям"];

function assigneeLabel(t) {
  const u = t.assignee_username;
  if (!u || u === "не назначен") return "не назначен";
  return /^[A-Za-z0-9_]+$/.test(u) ? `@${u}` : u;
}

const statusIcon = (t) => {
  if (t.status === "cancelled") return "🚫";
  if (t.status === "completed") return "🟢";
  if (t.status === "in_progress") return "🟡";
  return "⏳";
};

function fmtDuration(sec) {
  sec = Number(sec);
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60} мин`;
  return `${Math.round(h / 24)} дн`;
}

const pct = (a, b) => (Number(b) > 0 ? `${Math.round((Number(a) / Number(b)) * 100)}%` : "—");
const empName = (e) => e?.first_name || e?.username || "сотрудник";

// ═════════════════════════════ БД ═════════════════════════════
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
pool.on("error", (err) => console.error("PG pool error:", err.message));

// LEFT JOIN: задачи без зарегистрированного сотрудника тоже попадают в выборку
const TASK_EMP_JOIN = `
  LEFT JOIN employees e
    ON e.telegram_id = t.assignee_telegram_id
    OR (t.assignee_telegram_id IS NULL AND t.assignee_username IS NOT NULL
        AND LOWER(e.username) = LOWER(t.assignee_username))
`;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      telegram_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      task_title TEXT,
      assignee_username TEXT,
      creator_telegram_id TEXT,
      deadline TIMESTAMP WITH TIME ZONE,
      status TEXT DEFAULT 'pending',
      notified_expired BOOLEAN DEFAULT FALSE,
      reminder_sent BOOLEAN DEFAULT FALSE,
      extension_requested BOOLEAN DEFAULT FALSE,
      report_text TEXT
    );
    CREATE TABLE IF NOT EXISTS user_states (
      telegram_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      task_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bot_kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS task_files (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL,
      file_id TEXT NOT NULL,
      file_type TEXT NOT NULL,
      caption TEXT,
      sent BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS recurring_tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      assignee_username TEXT,
      assignee_telegram_id TEXT,
      freq TEXT NOT NULL,
      weekday INTEGER,
      day_of_month INTEGER,
      due_time TEXT NOT NULL,
      last_run_day TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS task_comments (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL,
      author_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    );
  `);

  // Колонки-«маркеры первого запуска»: старые задачи не должны получить уведомления разом после обновления
  const hasCol = async (name) =>
    (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = $1`, [name]))
      .rows.length > 0;
  const firstEscalationRun = !(await hasCol("escalated"));
  const firstRiskRun = !(await hasCol("risk_notified"));

  await pool.query(`
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS assignee_telegram_id TEXT,
      ADD COLUMN IF NOT EXISTS creator_telegram_id TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS notified_expired BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS extension_requested BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS report_text TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS ai_review TEXT,
      ADD COLUMN IF NOT EXISTS escalated BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS checklist JSONB,
      ADD COLUMN IF NOT EXISTS recurring_id INTEGER,
      ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal',
      ADD COLUMN IF NOT EXISTS project TEXT,
      ADD COLUMN IF NOT EXISTS depends_on INTEGER,
      ADD COLUMN IF NOT EXISTS risk_notified BOOLEAN DEFAULT FALSE;
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS away_until TIMESTAMP WITH TIME ZONE;
    ALTER TABLE recurring_tasks
      ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal',
      ADD COLUMN IF NOT EXISTS project TEXT;
  `);

  if (firstEscalationRun) await pool.query(`UPDATE tasks SET escalated = TRUE WHERE deadline < now()`);
  if (firstRiskRun) await pool.query(`UPDATE tasks SET risk_notified = TRUE`);
}

async function getState(userId) {
  const r = await pool.query(`SELECT action, task_id FROM user_states WHERE telegram_id = $1`, [userId]);
  return r.rows[0] || null;
}
async function setState(userId, action, taskId) {
  await pool.query(
    `INSERT INTO user_states (telegram_id, action, task_id) VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET action = EXCLUDED.action, task_id = EXCLUDED.task_id`,
    [userId, action, taskId]
  );
}
async function clearState(userId) {
  await pool.query(`DELETE FROM user_states WHERE telegram_id = $1`, [userId]);
}

// «Один раз в день»: true только первому, кто заявил ключ на этот день (переживает перезапуски)
async function claimDaily(key, day) {
  const r = await pool.query(
    `INSERT INTO bot_kv (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
     WHERE bot_kv.value IS DISTINCT FROM EXCLUDED.value
     RETURNING key`,
    [key, day]
  );
  return r.rows.length > 0;
}

async function getTask(id) {
  const r = await pool.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

const isClosed = (t) => t.status === "completed" || t.status === "cancelled";

function isAssignee(task, from) {
  const uid = String(from.id);
  if (task.assignee_telegram_id && task.assignee_telegram_id === uid) return true;
  if (
    task.assignee_username &&
    from.username &&
    task.assignee_username.toLowerCase() === from.username.toLowerCase()
  ) return true;
  return false;
}

// telegram_id исполнителя: из задачи или по username из employees
async function resolveAssigneeId(task) {
  if (task.assignee_telegram_id) return task.assignee_telegram_id;
  if (!task.assignee_username) return null;
  const r = await pool.query(`SELECT telegram_id FROM employees WHERE LOWER(username) = LOWER($1)`, [
    task.assignee_username,
  ]);
  return r.rows[0]?.telegram_id || null;
}

async function lookupEmployee(name) {
  if (!name) return null;
  const r = await pool.query(
    `SELECT telegram_id, username, first_name, away_until FROM employees
     WHERE LOWER(username) = LOWER($1) OR LOWER(first_name) = LOWER($1) LIMIT 1`,
    [name]
  );
  return r.rows[0] || null;
}

// ═════════════════════════════ ИИ: Gemini (+ запасной Groq) ═════════════════════════════
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const modelCooldown = new Map(); // model -> timestamp, до которого модель не трогаем
let lastAIError = null;

function classifyAIError(err) {
  const msg = String(err?.message || err || "");
  const status = Number(err?.status || err?.code || 0);
  if (/API key not valid|API_KEY_INVALID|UNAUTHENTICATED|PERMISSION_DENIED/i.test(msg) || status === 401 || status === 403) return "auth";
  if (status === 404 || /\b404\b|NOT_FOUND|no longer available|is not found/i.test(msg)) return "notfound";
  if (status === 429 || /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(msg)) return "quota";
  if (
    [500, 502, 503, 504].includes(status) ||
    /\b50[0234]\b|UNAVAILABLE|overloaded|INTERNAL|DEADLINE_EXCEEDED|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)
  ) return "overload";
  return "other";
}

function quotaCooldownMs(msg) {
  if (/PerDay|per day|daily/i.test(msg)) return 30 * 60 * 1000; // дневной лимит — проверим через 30 мин
  const m =
    String(msg).match(/retry in (\d+(?:\.\d+)?)\s*s/i) ||
    String(msg).match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  const sec = m ? parseFloat(m[1]) : 60;
  return Math.min(Math.max(Math.ceil(sec * 1000), 5000), 5 * 60 * 1000);
}

const readyModels = () => {
  const now = Date.now();
  return MODEL_CANDIDATES.filter((m) => (modelCooldown.get(m) || 0) <= now);
};

async function groqChat(prompt, { json }) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return String(j.choices?.[0]?.message?.content || "").trim();
}

async function groqTranscribe(buf, mime = "audio/ogg") {
  const ext = /mpeg|mp3/i.test(mime) ? "mp3" : /mp4|m4a|aac/i.test(mime) ? "m4a" : /wav/i.test(mime) ? "wav" : "ogg";
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: mime }), `audio.${ext}`);
  fd.append("model", GROQ_STT_MODEL);
  fd.append("response_format", "json");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`Groq STT HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return String(j.text || "").trim();
}

// contents: строка или массив частей. media=true — есть аудио/картинки (Groq-запасной канал не подходит)
async function gen(contents, { json = false, media = false } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let list = readyModels();
    if (!list.length) {
      // Все модели «отдыхают»: если ждать недолго — подождём, иначе сразу к запасному каналу
      const soonest = MODEL_CANDIDATES.reduce((a, m) => Math.min(a, modelCooldown.get(m) || 0), Infinity);
      const wait = soonest - Date.now();
      if (wait > 0 && wait <= 20000) {
        await sleep(wait + 200);
        list = readyModels();
      }
      if (!list.length) break;
    }
    for (const model of list) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          ...(json ? { config: { responseMimeType: "application/json" } } : {}),
        });
        return (response.text || "").trim();
      } catch (err) {
        lastErr = err;
        lastAIError = err;
        const kind = classifyAIError(err);
        const msg = String(err?.message || err);
        console.warn(`Gemini ${model}: ${kind} — ${msg.slice(0, 200)}`);
        if (kind === "auth") throw err;
        if (kind === "notfound") modelCooldown.set(model, Date.now() + 6 * 3600 * 1000);
        else if (kind === "quota") modelCooldown.set(model, Date.now() + quotaCooldownMs(msg));
        else if (kind === "overload") modelCooldown.set(model, Date.now() + 15000);
      }
    }
    if (attempt < 2) await sleep(1000);
  }

  if (!media && typeof contents === "string" && process.env.GROQ_API_KEY) {
    try {
      return await groqChat(contents, { json });
    } catch (e) {
      console.error("Groq fallback:", e.message);
    }
  }
  throw lastErr || lastAIError || new Error("RESOURCE_EXHAUSTED: все модели ИИ сейчас недоступны");
}

// Расшифровка голоса: Gemini, при сбое — Groq Whisper (если задан GROQ_API_KEY)
async function transcribeAudio(buf, mime = "audio/ogg") {
  try {
    const t = await gen(
      [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: buf.toString("base64") } },
            {
              text:
                "Дословно расшифруй эту аудиозапись. Верни только текст сказанного, без комментариев. " +
                "Сохрани имена, @username, даты и время как были произнесены.",
            },
          ],
        },
      ],
      { media: true }
    );
    if (t) return t;
    throw new Error("empty transcript");
  } catch (e) {
    if (!process.env.GROQ_API_KEY) throw e;
    try {
      return await groqTranscribe(buf, mime);
    } catch (e2) {
      console.error("Groq STT:", e2.message);
      throw e;
    }
  }
}

// Понятное объяснение ошибки ИИ (показываем только руководителю)
function explainAIError(err) {
  const msg = String(err?.message || err || "");
  const hint = process.env.GROQ_API_KEY ? "" : " Совет: добавьте бесплатный GROQ_API_KEY на Render — это запасной канал для голоса и текста.";
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg))
    return "ключ Gemini неверный или не имеет доступа (проверьте GEMINI_API_KEY на Render)";
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg))
    return "исчерпан лимит запросов Gemini по всем моделям (подождите пару минут или включите оплату в AI Studio)." + hint;
  if (/503|UNAVAILABLE|overloaded/i.test(msg))
    return "сервис Gemini временно перегружен, повторите через минуту." + hint;
  if (/404|NOT_FOUND|not found/i.test(msg))
    return "модель Gemini недоступна (задайте на Render переменную GEMINI_MODEL, например gemini-2.5-flash)";
  if (/Telegram file HTTP/i.test(msg)) return "не удалось скачать файл из Telegram";
  if (/empty transcript/i.test(msg)) return "речь не распознана (слишком тихо или пустая запись)";
  return "неизвестная ошибка, подробности в логах Render (строка «Voice processing error»)";
}

function parseJSONLoose(raw) {
  let s = String(raw).trim().replace(/```json/gi, "").replace(/```/g, "").trim();
  const f = s.indexOf("{"), l = s.lastIndexOf("}");
  if (f !== -1 && l !== -1) s = s.slice(f, l + 1);
  return JSON.parse(s);
}

// ═════════════════════════════ Бот ═════════════════════════════
const bot = new Bot(TOKEN);

async function downloadTgFile(fileId) {
  const file = await bot.api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

bot.catch((err) => {
  console.error("Ошибка в хендлере:", err.error?.message || err.message || err);
});

// Группы: бот реагирует только на CEO и только на сообщения с @упоминанием бота
bot.use(async (ctx, next) => {
  if (!ctx.chat || ctx.chat.type === "private") return next();
  if (!ctx.from || String(ctx.from.id) !== CEO_ID) return;
  if (ctx.callbackQuery) return next();
  const msg = ctx.message;
  const text = msg?.text || msg?.caption || "";
  const uname = ctx.me?.username;
  if (!uname) return;
  const re = new RegExp(`@${uname}\\b`, "ig");
  if (!re.test(text)) return;
  const clean = text.replace(new RegExp(`@${uname}\\b`, "ig"), "").trim();
  if (msg.text !== undefined) msg.text = clean;
  if (msg.caption !== undefined) msg.caption = clean;
  return next();
});

const safeSend = (chatId, text, extra = {}) =>
  bot.api.sendMessage(chatId, text, { ...HTML, ...extra }).catch((e) => {
    console.error(`sendMessage -> ${chatId} failed:`, e.message);
    return null;
  });

// Сообщение сотруднику с учётом отпуска и тихих часов
async function sendToEmp(row, text, extra = {}) {
  if (!row?.telegram_id) return null;
  if (isAway(row)) return null;
  return safeSend(row.telegram_id, text, { ...quietExtra(row), ...extra });
}

function taskBody(t) {
  let s = `📝 <b>Задача #${t.id}:</b> ${esc(t.task_title)}`;
  if (PRIO_LABEL[t.priority]) s += `\n${PRIO_LABEL[t.priority]}`;
  if (t.project) s += `\n📁 <b>Проект:</b> ${esc(t.project)}`;
  s += `\n⏰ <b>Срок:</b> ${fmt(t.deadline)}`;
  if (t.depends_on) s += `\n⛓ Начинать после задачи #${t.depends_on}`;
  return s;
}

function empKeyboard(id, withAccept = true) {
  const kb = new InlineKeyboard();
  if (withAccept) kb.text("🚀 Взял в работу", `emp_accept_${id}`);
  kb.text("✅ Завершить", `emp_complete_${id}`)
    .row()
    .text("⏱ Запросить отсрочку", `emp_extend_${id}`)
    .row()
    .text("🧩 План по шагам", `plan_${id}`)
    .text("💬 Написать", `cm_${id}`);
  return kb;
}

// Кнопки быстрых действий руководителя по задаче
function ceoTaskKeyboard(id) {
  return new InlineKeyboard()
    .text("🔔 Напомнить", `remind_${id}`)
    .text("👥 Передать", `re_${id}`)
    .row()
    .text("💬 Написать", `cm_${id}`)
    .text("🧩 Разбить на шаги", `plan_${id}`)
    .row()
    .text("🗑 Отменить задачу", `ceo_cancel_${id}`);
}

// Временные хранилища (живут в памяти до 30 мин)
const PENDING_TTL = 30 * 60 * 1000;
const pendingActions = new Map();    // token -> { a, targetIds, ts }
const pendingProposals = new Map();  // token -> { items, ts }
const newToken = () => crypto.randomBytes(4).toString("hex");
function putPending(map, data) {
  const token = newToken();
  map.set(token, { ...data, ts: Date.now() });
  return token;
}
function getPending(map, token) {
  const p = map.get(token);
  if (!p) return null;
  if (Date.now() - p.ts > PENDING_TTL) {
    map.delete(token);
    return null;
  }
  return p;
}
function sweepPending() {
  const now = Date.now();
  for (const m of [pendingActions, pendingProposals]) {
    for (const [k, v] of m) if (now - v.ts > PENDING_TTL) m.delete(k);
  }
}

// ─── Меню команд (появляется при вводе «/») ───
async function setCeoCommands() {
  await bot.api.setMyCommands(
    [
      { command: "staff", description: "Сотрудники и постановка задачи" },
      { command: "tasks", description: "Сводка по задачам (можно: /tasks проект)" },
      { command: "task", description: "Карточка задачи: /task 12" },
      { command: "brief", description: "ИИ-брифинг по задачам сейчас" },
      { command: "voice", description: "Голосовой брифинг" },
      { command: "meeting", description: "Протокол совещания → задачи" },
      { command: "stats", description: "Статистика и индекс надёжности" },
      { command: "weekly", description: "Недельный отчёт" },
      { command: "export", description: "Выгрузка задач в Excel" },
      { command: "recurring", description: "Повторяющиеся задачи" },
      { command: "ai", description: "Состояние ИИ (диагностика)" },
      { command: "cancel", description: "Отменить текущее действие" },
      { command: "start", description: "Перезапустить бота" },
    ],
    { scope: { type: "chat", chat_id: Number(CEO_ID) } }
  );
}

async function setCommands() {
  await bot.api.setMyCommands([
    { command: "my_tasks", description: "Мои активные задачи" },
    { command: "cancel", description: "Отменить текущее действие" },
    { command: "start", description: "Регистрация в боте" },
  ]);
  await setCeoCommands().catch((e) =>
    console.error("CEO commands (будут выставлены после /start CEO):", e.message)
  );
}

// ─── /start ───
bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const telegramId = String(ctx.from.id);
  const username = ctx.from.username ? ctx.from.username.trim().toLowerCase() : null;
  const firstName = ctx.from.first_name || "Сотрудник";

  try {
    const existed = await pool.query(`SELECT 1 FROM employees WHERE telegram_id = $1`, [telegramId]);
    await pool.query(
      `INSERT INTO employees (telegram_id, username, first_name) VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name`,
      [telegramId, username, firstName]
    );
    if (existed.rows.length === 0 && telegramId !== CEO_ID) {
      await safeSend(
        CEO_ID,
        `🆕 <b>Новый сотрудник в боте:</b> ${esc(firstName)}${username ? " (@" + esc(username) + ")" : ""}\nПоставить задачу: /staff`
      );
    }

    // Привязываем уже созданные задачи и повторяющиеся шаблоны к этому сотруднику
    if (username) {
      await pool.query(
        `UPDATE tasks SET assignee_telegram_id = $1
         WHERE assignee_telegram_id IS NULL AND LOWER(assignee_username) = LOWER($2)`,
        [telegramId, username]
      );
      await pool.query(
        `UPDATE recurring_tasks SET assignee_telegram_id = $1
         WHERE assignee_telegram_id IS NULL AND LOWER(assignee_username) = LOWER($2)`,
        [telegramId, username]
      );
    }

    if (telegramId === CEO_ID) {
      await setCeoCommands().catch((e) => console.error("CEO commands:", e.message));
      await ctx.reply(
        `👋 Здравствуйте, ${esc(CEO_NAME)}! Бот управления ${esc(COMPANY_NAME)} активирован.\n\n` +
          "<b>Что я умею:</b>\n" +
          "• Пишите задачу текстом или голосом, можно сразу несколько: «Ержану отчёт до завтра, Айгуль созвониться в пятницу». Слова «срочно» и «важно» задают приоритет, «по проекту X» — проект\n" +
          "• Управляйте речью: «Перенеси задачу Ержана на пятницу», «Отмени всё у Айгуль», «Напомни Ержану про отчёт», «Ержан в отпуске до 20 декабря»\n" +
          "• Спрашивайте: «Что сейчас горит?», «Что по проекту X?»\n" +
          "• Повторяющиеся: «Каждый понедельник до 10:00 Ержану отчёт по продажам»\n" +
          "• Присылайте фото, скриншот, PDF или пересылайте сообщения — выделю из них задачи\n" +
          "• Длинное голосовое или аудио совещания — составлю протокол и задачи (/meeting)\n" +
          "• В группе: упомяните меня @бот и напишите задачу\n\n" +
          "/staff — сотрудники · /tasks — сводка · /task 12 — карточка\n" +
          "/brief · /voice — брифинг · /stats — статистика · /weekly — отчёт недели\n" +
          "/export — Excel · /recurring — повторы · /ai — диагностика ИИ",
        HTML
      );
    } else {
      await ctx.reply(
        `👋 Привет, ${esc(firstName)}! Вы успешно зарегистрированы в системе задач ${esc(COMPANY_NAME)}.\n\n/my_tasks — ваши активные задачи`,
        HTML
      );
    }
  } catch (err) {
    console.error("Ошибка регистрации:", err);
    await ctx.reply("Произошла ошибка при регистрации.");
  }
});

// ─── /staff: список сотрудников для CEO ───
const ceoAssign = new Map(); // CEO_ID -> { emp, ts }: выбранный сотрудник для следующей задачи
const ASSIGN_TTL = 15 * 60 * 1000;

function getCeoAssign(userId) {
  const a = ceoAssign.get(userId);
  if (!a) return null;
  if (Date.now() - a.ts > ASSIGN_TTL) {
    ceoAssign.delete(userId);
    return null;
  }
  return a;
}

// Режим «следующее сообщение — совещание»
const ceoMeeting = new Map();
function takeMeetingMode() {
  const ts = ceoMeeting.get(CEO_ID);
  ceoMeeting.delete(CEO_ID);
  return !!ts && Date.now() - ts < ASSIGN_TTL;
}

bot.command("staff", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  try {
    const r = await pool.query(
      `SELECT telegram_id, username, first_name, away_until FROM employees WHERE telegram_id != $1 ORDER BY first_name`,
      [CEO_ID]
    );
    if (r.rows.length === 0) {
      return ctx.reply("📭 Пока никто из сотрудников не нажал /start. Отправьте им ссылку на бота.");
    }
    const kb = new InlineKeyboard();
    r.rows.forEach((e, i) => {
      const label = `${isAway(e) ? "🏖 " : ""}${e.first_name || "Без имени"}${e.username ? " (@" + e.username + ")" : ""}`;
      kb.text(label, `pick_${e.telegram_id}`);
      if (i % 2 === 1) kb.row();
    });
    await ctx.reply(
      `👥 <b>Сотрудники в боте (${r.rows.length}):</b>\nНажмите на сотрудника, чтобы поставить ему задачу. 🏖 — в отпуске.`,
      { ...HTML, reply_markup: kb }
    );
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Не удалось загрузить список сотрудников.");
  }
});

// ─── /cancel ───
bot.command("cancel", async (ctx) => {
  await clearState(String(ctx.from.id));
  ceoAssign.delete(String(ctx.from.id));
  ceoMeeting.delete(String(ctx.from.id));
  await ctx.reply("Ок, действие отменено.");
});

// ─── /meeting ───
bot.command("meeting", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  ceoMeeting.set(CEO_ID, Date.now());
  await ctx.reply(
    "🎧 Пришлите запись совещания (голосовое или аудиофайл) либо текст/расшифровку — я составлю протокол и предложу задачи. Отмена: /cancel"
  );
});

// ─── /ai: диагностика ───
bot.command("ai", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  const now = Date.now();
  let msg = "🧠 <b>Состояние ИИ</b>\n\n";
  for (const m of MODEL_CANDIDATES) {
    const until = modelCooldown.get(m) || 0;
    msg += until > now ? `⏸ ${esc(m)} — пауза ещё ${Math.ceil((until - now) / 1000)} с\n` : `✅ ${esc(m)} — доступна\n`;
  }
  msg += `\nЗапасной канал Groq: ${process.env.GROQ_API_KEY ? "подключён ✅" : "не подключён (GROQ_API_KEY)"}`;
  msg += `\nГолосовой брифинг: ${VOICE_BRIEF ? "включён" : "выключен"} (${esc(TTS_MODEL)})`;
  msg += `\nТихие часы: ${QUIET_ON ? `${QUIET_START}:00–${QUIET_END}:00` : "выключены"}${QUIET_WEEKENDS ? " + выходные" : ""}`;
  if (lastAIError) msg += `\n\nПоследняя ошибка: <code>${esc(String(lastAIError.message || lastAIError).slice(0, 250))}</code>`;
  const wait = await ctx.reply(msg + "\n\n⏳ Проверяю связь…", HTML);
  try {
    const t0 = Date.now();
    const out = await gen("Ответь одним словом: ok");
    await ctx.api.editMessageText(
      ctx.chat.id, wait.message_id,
      msg + `\n\n✅ Тест пройден за ${Date.now() - t0} мс: «${esc(out.slice(0, 40))}»`, HTML
    ).catch(() => {});
  } catch (e) {
    await ctx.api.editMessageText(
      ctx.chat.id, wait.message_id,
      msg + `\n\n❌ Тест не пройден: ${esc(explainAIError(e))}`, HTML
    ).catch(() => {});
  }
});

// ─── /tasks (сводка для CEO, с отменой; фильтр: /tasks Ержан или /tasks проект) ───
bot.command("tasks", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  try {
    const q = String(ctx.match || "").trim().replace(/^@/, "");
    const res = await pool.query(
      `SELECT id, task_title, assignee_username, status, deadline, checklist, priority, project
       FROM tasks
       WHERE ($1 = '' OR project ILIKE '%' || $1 || '%' OR assignee_username ILIKE '%' || $1 || '%' OR task_title ILIKE '%' || $1 || '%')
       ORDER BY CASE WHEN status IN ('completed','cancelled') THEN 3 WHEN priority = 'urgent' THEN 0 WHEN priority = 'important' THEN 1 ELSE 2 END,
                CASE WHEN status IN ('completed','cancelled') THEN NULL ELSE deadline END ASC NULLS LAST,
                id DESC
       LIMIT 15`,
      [q]
    );
    if (res.rows.length === 0) return ctx.reply(q ? `📭 По запросу «${q}» задач нет.` : "📭 В базе пока нет задач.");

    const now = Date.now();
    let msg = `📊 <b>Сводка по задачам ${esc(COMPANY_NAME)}${q ? ` · «${esc(q)}»` : ""}:</b>\n\n`;
    const kb = new InlineKeyboard();
    let btnCount = 0;
    for (const t of res.rows) {
      const active = !isClosed(t);
      const overdue = active && new Date(t.deadline).getTime() < now;
      const icon = overdue ? "🔴" : statusIcon(t);
      msg += `${icon} <b>#${t.id}</b> | ${esc(assigneeLabel(t))} ${prioIcon(t)}\n`;
      msg += `📝 ${esc(t.task_title)}\n`;
      if (t.project) msg += `📁 ${esc(t.project)}\n`;
      msg += `📌 Статус: <code>${esc(t.status)}</code> | Срок: ${fmt(t.deadline)}${overdue ? " (просрочено)" : ""}\n`;
      if (Array.isArray(t.checklist) && t.checklist.length) {
        msg += `🧩 План: ${t.checklist.filter((s) => s.done).length}/${t.checklist.length}\n`;
      }
      msg += "\n";
      if (active) {
        kb.text(`⚙️ #${t.id}`, `card_${t.id}`);
        btnCount++;
        if (btnCount % 4 === 0) kb.row();
      }
    }
    if (btnCount > 0) msg += "<i>Кнопки ⚙️ открывают карточку задачи с действиями.</i>";
    await ctx.reply(msg.slice(0, 4000), btnCount > 0 ? { ...HTML, reply_markup: kb } : HTML);
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Не удалось загрузить задачи.");
  }
});

// ─── Карточка задачи ───
async function sendTaskCard(chatId, id) {
  const t = await getTask(id);
  if (!t) return safeSend(chatId, "⚠️ Задача не найдена.");
  const comments = await pool.query(
    `SELECT c.text, c.created_at, c.author_id, e.first_name
     FROM task_comments c LEFT JOIN employees e ON e.telegram_id = c.author_id
     WHERE c.task_id = $1 ORDER BY c.id DESC LIMIT 5`,
    [id]
  );
  let msg = `${statusIcon(t)} ${taskBody(t)}\n👤 ${esc(assigneeLabel(t))}\n📌 Статус: ${esc(STATUS_RU[t.status] || t.status)}`;
  if (Array.isArray(t.checklist) && t.checklist.length) {
    msg += `\n🧩 План: ${t.checklist.filter((s) => s.done).length}/${t.checklist.length}`;
  }
  if (t.report_text) msg += `\n\n<b>Отчёт:</b> ${esc(String(t.report_text).slice(0, 700))}`;
  if (t.ai_review) msg += `\n🤖 ${esc(t.ai_review)}`;
  if (comments.rows.length) {
    msg += "\n\n💬 <b>Переписка:</b>\n";
    for (const c of comments.rows.reverse()) {
      const who = c.author_id === CEO_ID ? CEO_NAME : c.first_name || "сотрудник";
      msg += `• <b>${esc(who)}</b> (${fmt(c.created_at)}): ${esc(String(c.text).slice(0, 300))}\n`;
    }
  }
  const kb = isClosed(t)
    ? t.status === "completed"
      ? new InlineKeyboard().text("↩️ Вернуть на доработку", `ceo_reopen_${id}`)
      : undefined
    : ceoTaskKeyboard(id);
  return safeSend(chatId, msg.slice(0, 4000), kb ? { reply_markup: kb } : {});
}

bot.command("task", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  const id = parseInt(String(ctx.match || "").replace(/[^\d]/g, ""), 10);
  if (!id) return ctx.reply("Укажите номер задачи: /task 12");
  await sendTaskCard(ctx.chat.id, id);
});

// ─── /my_tasks ───
bot.command("my_tasks", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const telegramId = String(ctx.from.id);
  try {
    const empRes = await pool.query(`SELECT username FROM employees WHERE telegram_id = $1`, [telegramId]);
    if (empRes.rows.length === 0) return ctx.reply("⚠️ Сначала зарегистрируйтесь через /start");

    const username = empRes.rows[0].username;
    const tasksRes = await pool.query(
      `SELECT id, task_title, status, deadline, priority, project FROM tasks
       WHERE status NOT IN ('completed', 'cancelled')
         AND (assignee_telegram_id = $1 OR ($2::text IS NOT NULL AND LOWER(assignee_username) = LOWER($2)))
       ORDER BY id DESC`,
      [telegramId, username]
    );
    if (tasksRes.rows.length === 0) return ctx.reply("📭 У вас нет активных задач. Отличная работа!");

    let msg = "📋 <b>Ваши текущие задачи:</b>\n\n";
    for (const t of tasksRes.rows) {
      msg += `📌 <b>Задача #${t.id}</b> ${prioIcon(t)}\n📝 ${esc(t.task_title)}\n`;
      if (t.project) msg += `📁 ${esc(t.project)}\n`;
      msg += `⏰ Срок: ${fmt(t.deadline)}\n\n`;
    }
    await ctx.reply(msg.slice(0, 4000), HTML);
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Ошибка при загрузке задач.");
  }
});

// ═════════════════════════════ Разбор сообщений CEO ═════════════════════════════
function normalizeDates(s) {
  return String(s ?? "")
    .replace(/\b(\d{1,2})[:\/-](\d{1,2})[:\/-](\d{4})\b/g, "$1.$2.$3")
    .replace(/\b(\d{1,2})\s+(\d{1,2})\s+(20\d{2})\b/g, "$1.$2.$3");
}

// Запасной парсер дедлайна, если ИИ недоступен или не вернул срок
function fallbackDeadline(text, now = new Date()) {
  const inMin = text.match(/через\s*(\d+)\s*(?:мин|минут|минуту)/i);
  if (inMin) return new Date(now.getTime() + parseInt(inMin[1], 10) * 60000);

  const inHours = text.match(/через\s*(\d+)\s*(?:час|часа|часов)/i);
  if (inHours) return new Date(now.getTime() + parseInt(inHours[1], 10) * 3600000);

  const p = localParts(now);
  let { y, mo, d } = p;
  let explicitDay = false;

  const full = text.match(/(\d{1,2})[.:\/-](\d{1,2})[.:\/-](\d{4})/);
  if (full) {
    d = parseInt(full[1], 10); mo = parseInt(full[2], 10) - 1; y = parseInt(full[3], 10);
    explicitDay = true;
  } else if (/послезавтра/i.test(text)) {
    d += 2; explicitDay = true;
  } else if (/завтра/i.test(text)) {
    d += 1; explicitDay = true;
  } else if (/сегодня/i.test(text)) {
    explicitDay = true;
  }

  const time = text.replace(/(\d{1,2})[.:\/-](\d{1,2})[.:\/-](\d{4})/, " ").match(/(\d{1,2}):(\d{2})/);
  if (!explicitDay && !time) return null;

  const h = time ? parseInt(time[1], 10) : 18;
  const mi = time ? parseInt(time[2], 10) : 0;
  let result = localToUtc(y, mo, d, h, mi);
  if (!explicitDay && result <= now) result = new Date(result.getTime() + 86400000);
  return result;
}

// Правило повторения от ИИ -> проверенный объект (или null)
function validRecurrence(r) {
  if (!r || typeof r !== "object") return null;
  const freq = String(r.freq || "").toLowerCase();
  if (!["daily", "weekdays", "weekly", "monthly"].includes(freq)) return null;

  const m = String(r.time || "").match(/^(\d{1,2}):(\d{2})$/);
  let hh = m ? Math.min(23, parseInt(m[1], 10)) : 18;
  let mm = m ? Math.min(59, parseInt(m[2], 10)) : 0;
  let clamped = false;
  if (hh * 60 + mm < SPAWN_HOUR * 60 + 30) { hh = SPAWN_HOUR; mm = 30; clamped = true; }

  const out = { freq, weekday: null, day_of_month: null, time: `${pad2(hh)}:${pad2(mm)}`, clamped };
  if (freq === "weekly") {
    const w = parseInt(r.weekday, 10);
    if (!(w >= 1 && w <= 7)) return null;
    out.weekday = w;
  }
  if (freq === "monthly") {
    const d = parseInt(r.day_of_month, 10);
    if (!(d >= 1 && d <= 31)) return null;
    out.day_of_month = d;
  }
  return out;
}

function ruleMatches(rule, isoWd, dayOfMonth, daysInMonth) {
  switch (rule.freq) {
    case "daily": return true;
    case "weekdays": return isoWd <= 5;
    case "weekly": return isoWd === rule.weekday;
    case "monthly":
      return rule.day_of_month === dayOfMonth || (rule.day_of_month > daysInMonth && dayOfMonth === daysInMonth);
    default: return false;
  }
}

function describeRule(r) {
  if (r.freq === "daily") return "каждый день";
  if (r.freq === "weekdays") return "по будням";
  if (r.freq === "weekly") return `по ${WEEKDAYS_DAT[(r.weekday || 1) - 1]}`;
  if (r.freq === "monthly") return `ежемесячно, ${r.day_of_month}-го числа`;
  return r.freq;
}

function nextRunLabel(rule, includeToday = false) {
  const base = localParts();
  for (let i = includeToday ? 0 : 1; i <= 400; i++) {
    const dt = new Date(Date.UTC(base.y, base.mo, base.d + i));
    const isoWd = ((dt.getUTCDay() + 6) % 7) + 1;
    const dim = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    if (ruleMatches(rule, isoWd, dt.getUTCDate(), dim)) {
      return dt.toLocaleDateString("ru-RU", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
    }
  }
  return null;
}

const normPriority = (p) => (["urgent", "important"].includes(String(p || "").toLowerCase()) ? String(p).toLowerCase() : "normal");
const cleanStr = (v, max = 100) =>
  v && String(v).toLowerCase() !== "null" ? String(v).replace("@", "").trim().slice(0, max) || null : null;

// Задача от ИИ -> нормализованный объект
function normAiTask(t) {
  return {
    title: String(t?.title || "").trim().slice(0, 300),
    user: cleanStr(t?.user),
    deadline: t?.deadline_iso && !isNaN(Date.parse(t.deadline_iso)) ? new Date(t.deadline_iso) : null,
    recurrence: validRecurrence(t?.recurrence),
    priority: normPriority(t?.priority),
    project: cleanStr(t?.project, 80),
  };
}

// Действие от ИИ -> проверенный объект
const ACTION_TYPES = ["reschedule", "extend", "cancel", "remind", "reopen", "reassign", "priority", "depends", "away", "back"];
function normAction(a) {
  if (!a || typeof a !== "object") return null;
  const type = String(a.type || "").toLowerCase();
  if (!ACTION_TYPES.includes(type)) return null;
  const num = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const dt = (v) => (v && !isNaN(Date.parse(v)) ? new Date(v) : null);
  const pr = String(a.priority || "").toLowerCase();
  return {
    type,
    scope: a.scope === "all" ? "all" : "one",
    task_id: num(a.task_id),
    hint: cleanStr(a.task_hint, 120),
    user: cleanStr(a.user),
    to_user: cleanStr(a.to_user),
    deadline: dt(a.deadline_iso),
    priority: ["urgent", "important", "normal"].includes(pr) ? pr : null,
    after_task: num(a.after_task),
    until: dt(a.until_iso),
  };
}

async function aiHeader() {
  const now = new Date();
  const nowLocalIso = new Date(now.getTime() + TZ_OFFSET_H * 3600000).toISOString().replace("Z", "+05:00");
  const weekday = now.toLocaleDateString("ru-RU", { timeZone: TZ, weekday: "long" });
  let staffList = "";
  try {
    const s = await pool.query(`SELECT username, first_name FROM employees WHERE telegram_id != $1`, [CEO_ID]);
    staffList = s.rows
      .map((e) => `${e.first_name || ""}${e.username ? " (@" + e.username + ")" : ""}`.trim())
      .filter(Boolean)
      .join("; ");
  } catch (e) {
    console.error("staff list for AI:", e.message);
  }
  return { now, nowLocalIso, weekday, staffList };
}

const TASK_RULES = `- title: краткая суть задачи без имени исполнителя и срока.
- user: если исполнитель совпал с кем-то из списка сотрудников (учти падежи: Ержану, Ержана) — его username без @, а если у него нет username — его имя из списка; если в списке нет — имя из текста; иначе null.
- deadline_iso: срок в формате ISO 8601 с оффсетом +05:00 или null, если не указан. Относительные сроки («завтра», «в пятницу», «через 3 часа») считай от текущего времени.
- priority: "urgent" если сказано «срочно», «горит», «немедленно», «сегодня же»; "important" если «важно», «приоритет», «ключевое»; иначе "normal".
- project: название проекта или направления, если оно названо («по проекту X», «для клиента Y»), иначе null.
- recurrence: только если поручение повторяющееся («каждый понедельник», «ежедневно», «по будням», «каждого 5 числа»), иначе null. Формат: {"freq": "daily" | "weekdays" | "weekly" | "monthly", "weekday": число 1-7 (1=понедельник) для weekly, "day_of_month": число 1-31 для monthly, "time": "HH:MM" — время дедлайна в этот день или null}. Для повторяющихся задач deadline_iso = null.`;

// audio: { buf, mime } — голосовое от CEO: расшифровка и разбор делаются ОДНИМ запросом (экономия квоты)
async function parseCEOMessage(rawText, { audio = null } = {}) {
  const { now, nowLocalIso, weekday, staffList } = await aiHeader();
  let text = normalizeDates(rawText);

  const source = audio
    ? `Сообщение руководителя — голосовое (аудио приложено). Сначала дословно расшифруй его в поле "transcript".`
    : `Сообщение руководителя: """${text}"""`;

  const prompt = `Сейчас ${nowLocalIso} (${weekday}), часовой пояс UTC+5 (Астана).
Список сотрудников: ${staffList || "пусто"}.
${source}

Определи намерение руководителя и верни JSON строго такого вида:
{${audio ? '"transcript": "...", ' : ""}"intent": "tasks" | "question" | "action" | "other",
 "tasks": [{"title": "...", "user": "...", "deadline_iso": "...", "priority": "normal", "project": null, "recurrence": null}],
 "action": null}

Правила:
- intent="tasks": руководитель ставит одно или несколько поручений. Каждое отдельное поручение — отдельный элемент в tasks (например, «Ержану отчёт до завтра, Айгуль созвониться с клиентом» — это 2 задачи). action = null.
- intent="question": руководитель спрашивает о задачах, сроках, просрочках, сотрудниках или статусе (нужно ответить, а не создавать задачу). tasks = [], action = null.
- intent="action": руководитель просит изменить СУЩЕСТВУЮЩЕЕ: перенести срок, отменить, напомнить, вернуть на доработку, передать другому, поменять приоритет, связать задачи, сообщить об отпуске сотрудника. tasks = [], а action заполни:
  {"type": "reschedule" | "extend" | "cancel" | "remind" | "reopen" | "reassign" | "priority" | "depends" | "away" | "back",
   "scope": "one" | "all", "task_id": число или null, "task_hint": "ключевые слова задачи" или null, "user": "исполнитель (как в user выше)" или null,
   "to_user": "кому передать (для reassign)" или null, "deadline_iso": "новый срок (для reschedule)" или null,
   "priority": "urgent" | "important" | "normal" или null, "after_task": число или null (для depends: «задача #5 после #4» -> task_id=5, after_task=4),
   "until_iso": "до какой даты в отпуске (для away)" или null}
  Типы: reschedule — новый срок; extend — продлить (+24 часа); cancel — отменить; remind — напомнить исполнителю; reopen — вернуть выполненную на доработку; reassign — передать другому; priority — сменить приоритет; depends — зависимость; away — сотрудник в отпуске/недоступен до даты; back — сотрудник вернулся.
  scope="all" только если сказано «все задачи» / «всё у …». Номер задачи («#12», «задачу 12») клади в task_id.
- intent="other": приветствие, благодарность и прочее без задачи, вопроса и действия. tasks = [], action = null.
${TASK_RULES}`;

  const contents = audio
    ? [{ role: "user", parts: [{ inlineData: { mimeType: audio.mime, data: audio.buf.toString("base64") } }, { text: prompt }] }]
    : prompt;

  let intent = "tasks";
  let items = null; // null = ИИ не сработал
  let action = null;

  try {
    const raw = await gen(contents, { json: true, media: !!audio });
    const parsed = parseJSONLoose(raw);
    if (audio) {
      text = normalizeDates(String(parsed.transcript || "").trim());
      if (!text) throw new Error("empty transcript");
    }
    intent = ["tasks", "question", "action", "other"].includes(parsed.intent) ? parsed.intent : "tasks";
    items = (Array.isArray(parsed.tasks) ? parsed.tasks : []).slice(0, 10).map(normAiTask).filter((t) => t.title);
    if (intent === "action") {
      action = normAction(parsed.action);
      if (!action) intent = "other";
    }
  } catch (err) {
    console.error("AI parse error:", err.message);
    if (audio) throw err; // для голоса запасной вариант — расшифровка отдельно (см. обработчик)
  }

  const mu = text.match(/@([a-zA-Z0-9_]+)/);
  const fallbackItem = () => ({
    title: text,
    user: mu ? mu[1] : null,
    deadline: fallbackDeadline(text, now),
    recurrence: null,
    priority: /срочно|горит|немедленно/i.test(text) ? "urgent" : "normal",
    project: null,
  });

  if (items === null || (intent === "tasks" && items.length === 0)) {
    items = [fallbackItem()];
    intent = "tasks";
  }

  // Одна задача: явный @username и явная дата в тексте приоритетнее ИИ
  if (intent === "tasks" && items.length === 1) {
    const it = items[0];
    if (mu) it.user = mu[1];
    if (!it.recurrence) {
      if (/\d{1,2}\.\d{1,2}\.\d{4}/.test(text)) {
        const ex = fallbackDeadline(text, now);
        if (ex) it.deadline = ex;
      } else if (!it.deadline) {
        it.deadline = fallbackDeadline(text, now);
      }
    }
  }

  return { intent, items, action, text, fallbackItem };
}

// ═════════════════════════════ Создание задач ═════════════════════════════
async function notifyEmployeeNewTask(task, empId) {
  if (!empId) return null;
  return safeSend(empId, `📬 <b>Вам назначена новая задача!</b>\n\n${taskBody(task)}`, {
    ...quietExtra(task),
    reply_markup: empKeyboard(task.id, true),
  });
}

// Нагрузка сотрудника + предложение менее загруженного коллеги
async function workloadFor(emp, task) {
  try {
    const names = [emp.username, emp.first_name].filter(Boolean).map((s) => s.toLowerCase());
    const r = await pool.query(
      `SELECT COUNT(*) AS active, COUNT(*) FILTER (WHERE deadline < now()) AS overdue
       FROM tasks
       WHERE status NOT IN ('completed','cancelled')
         AND (assignee_telegram_id = $1 OR LOWER(assignee_username) = ANY($2::text[]))`,
      [emp.telegram_id, names]
    );
    const active = Number(r.rows[0].active);
    const overdue = Number(r.rows[0].overdue);
    if (active < WORKLOAD_WARN && overdue < 2) return null;

    const alt = await pool.query(
      `SELECT e.telegram_id, e.username, e.first_name,
              COUNT(t.id) FILTER (WHERE t.status NOT IN ('completed','cancelled')) AS active
       FROM employees e
       LEFT JOIN tasks t ON (t.assignee_telegram_id = e.telegram_id
            OR (t.assignee_telegram_id IS NULL AND LOWER(t.assignee_username) = LOWER(e.username)))
       WHERE e.telegram_id <> $1 AND e.telegram_id <> $2 AND (e.away_until IS NULL OR e.away_until < now())
       GROUP BY e.telegram_id, e.username, e.first_name
       ORDER BY active ASC, e.first_name
       LIMIT 1`,
      [emp.telegram_id, CEO_ID]
    );
    const a = alt.rows[0];
    const better = a && Number(a.active) + 2 <= active ? a : null;
    let text = `📊 У ${esc(empName(emp))} теперь ${active} активных задач${overdue ? `, из них просрочено ${overdue}` : ""}.`;
    if (better) text += ` Меньше загружен(а): ${esc(empName(better))} (${better.active}).`;
    return { text, alt: better, taskId: task.id };
  } catch (e) {
    console.error("workloadFor:", e.message);
    return null;
  }
}

async function createOneTask(item, forcedEmp) {
  const emp = forcedEmp || (await lookupEmployee(item.user));
  const assigneeName = emp?.username || emp?.first_name || item.user || null;

  // Повторяющаяся задача -> шаблон
  if (item.recurrence) {
    const rec = item.recurrence;
    const p = localParts();
    const [hh, mm] = rec.time.split(":").map(Number);
    const dueToday = localToUtc(p.y, p.mo, p.d, hh, mm);
    const lastRun = dueToday <= new Date() ? todayKey() : null;
    const r = await pool.query(
      `INSERT INTO recurring_tasks
         (title, assignee_username, assignee_telegram_id, freq, weekday, day_of_month, due_time, last_run_day, priority, project)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [item.title, assigneeName, emp?.telegram_id || null, rec.freq, rec.weekday, rec.day_of_month, rec.time, lastRun, item.priority || "normal", item.project || null]
    );
    return { kind: "recurring", rec: r.rows[0], emp, user: item.user, clamped: rec.clamped, lastRun };
  }

  const notes = [];
  let deadline = item.deadline;
  if (!deadline) {
    deadline = new Date(Date.now() + 86400000);
    notes.push("срок не указан — поставил +24 часа");
  } else if (deadline.getTime() <= Date.now()) {
    deadline = new Date(Date.now() + 86400000);
    notes.push("указанный срок уже прошёл — поставил +24 часа");
  }

  const ins = await pool.query(
    `INSERT INTO tasks (task_title, assignee_username, assignee_telegram_id, creator_telegram_id, deadline, status, priority, project)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7) RETURNING *`,
    [item.title, assigneeName, emp?.telegram_id || null, CEO_ID, deadline.toISOString(), item.priority || "normal", item.project || null]
  );
  const task = ins.rows[0];

  const away = emp ? isAway(emp) : false;
  if (away) notes.push(`${empName(emp)} в отпуске до ${fmtDate(emp.away_until)}`);
  const sent = emp && !away ? await notifyEmployeeNewTask(task, emp.telegram_id) : null;
  const workload = emp ? await workloadFor(emp, task) : null;
  return { kind: "task", task, emp, notes, sent: !!sent, away, user: item.user, workload };
}

function empStateLine(r) {
  if (r.emp) {
    if (r.away) return "🏖 <i>Сотрудник в отпуске — уведомление не отправлено. Задачу можно передать другому.</i>";
    return r.sent
      ? "✅ <i>Уведомление отправлено сотруднику в ЛС.</i>"
      : "⚠️ <i>Не удалось отправить сообщение сотруднику (возможно, он заблокировал бота).</i>";
  }
  if (r.user) {
    return `⚠️ <i>Сотрудник «${esc(r.user)}» ещё не нажал /start у бота. Как только нажмёт — задача привяжется к нему.</i>`;
  }
  return "⚠️ <i>Исполнитель не определён.</i>";
}

// Итоговое сообщение при создании нескольких задач
function renderMulti(results) {
  let msg = `📌 <b>Создано: ${results.filter((r) => r.kind !== "error").length} из ${results.length}</b>\n\n`;
  const kb = new InlineKeyboard();
  let n = 0;
  results.forEach((r, i) => {
    if (r.kind === "task") {
      const t = r.task;
      msg += `${i + 1}. <b>#${t.id}</b> ${prioIcon(t)}${esc(assigneeLabel(t))} — ${esc(t.task_title)}\n`;
      msg += `   ⏰ ${fmt(t.deadline)} ${r.emp ? (r.away ? "🏖 в отпуске" : r.sent ? "✅" : "⚠️ не доставлено") : "⚠️ нет /start"}`;
      if (r.notes.length) msg += ` · <i>${esc(r.notes.join("; "))}</i>`;
      msg += "\n";
      if (r.workload) msg += `   ${r.workload.text}\n`;
      kb.text(`⚙️ #${t.id}`, `card_${t.id}`);
    } else if (r.kind === "recurring") {
      msg += `${i + 1}. 🔁 <b>R${r.rec.id}</b> ${esc(assigneeLabel(r.rec))} — ${esc(r.rec.title)}\n`;
      msg += `   📅 ${esc(describeRule(r.rec))}, до ${r.rec.due_time}\n`;
      kb.text(`🗑 повтор R${r.rec.id}`, `rec_del_${r.rec.id}`);
    } else {
      msg += `${i + 1}. ❌ Не удалось создать: ${esc(r.title)}\n`;
      return;
    }
    n++;
    if (n % 3 === 0) kb.row();
  });
  return { msg: msg.slice(0, 4000), kb };
}

async function processTaskCreation(ctx, textSource, forcedEmp = null, preParsed = null, inGroup = false) {
  const statusMsg = await ctx.reply("🧠 ИИ анализирует сообщение...");
  const cleanup = () => ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
  try {
    const parsed = preParsed || (await parseCEOMessage(textSource));
    let { intent, items } = parsed;

    if (inGroup && intent !== "tasks") {
      await cleanup();
      return ctx.reply("💬 Вопросы и изменения задач лучше писать мне в личные сообщения.");
    }
    if (!forcedEmp && intent === "question") {
      await cleanup();
      return answerQuestion(ctx, parsed.text || textSource);
    }
    if (!forcedEmp && intent === "action") {
      await cleanup();
      return startAction(ctx, parsed.action);
    }
    if (!forcedEmp && (intent === "other" || items.length === 0)) {
      await cleanup();
      return ctx.reply(
        "🤔 Не вижу в сообщении задачи, вопроса или команды. Опишите поручение (кому, что, к какому сроку) или спросите про статус задач."
      );
    }
    if (forcedEmp && items.length === 0) items = [parsed.fallbackItem()];

    const results = [];
    for (const item of items) {
      try {
        results.push(await createOneTask(item, forcedEmp));
      } catch (e) {
        console.error("createOneTask error:", e);
        results.push({ kind: "error", title: item.title });
      }
    }
    await cleanup();

    // ── Одна задача ──
    if (results.length === 1) {
      const r = results[0];
      if (r.kind === "error") return ctx.reply("❌ Не удалось создать задачу. Попробуйте ещё раз.");

      if (r.kind === "recurring") {
        const rec = r.rec;
        const next = nextRunLabel(rec, !r.lastRun);
        let text =
          `🔁 <b>Повторяющаяся задача R${rec.id} создана!</b>\n\n` +
          `📝 ${esc(rec.title)}\n` +
          `👤 ${esc(assigneeLabel(rec))}\n` +
          `📅 ${esc(describeRule(rec))}, срок до ${rec.due_time}\n` +
          `🕗 Задача создаётся автоматически в ${pad2(SPAWN_HOUR)}:00 (Астана)` +
          (next ? `\n▶️ Ближайшая: ${esc(next)}` : "") +
          "\n";
        if (r.clamped) text += `\nℹ️ <i>Срок сдвинут на ${rec.due_time}: задачи создаются в ${pad2(SPAWN_HOUR)}:00.</i>\n`;
        text += `\n${r.emp ? "✅ <i>Сотрудник найден.</i>" : empStateLine(r)}`;
        return ctx.reply(text, {
          ...HTML,
          reply_markup: new InlineKeyboard().text("🗑 Удалить повтор", `rec_del_${rec.id}`),
        });
      }

      const task = r.task;
      let reply =
        `📌 <b>Задача #${task.id} создана!</b>\n\n` +
        `📝 <b>Суть:</b> ${esc(task.task_title)}\n` +
        `👤 <b>Исполнитель:</b> ${esc(assigneeLabel(task))}\n` +
        (PRIO_LABEL[task.priority] ? `${PRIO_LABEL[task.priority]}\n` : "") +
        (task.project ? `📁 <b>Проект:</b> ${esc(task.project)}\n` : "") +
        `⏰ <b>Дедлайн:</b> ${fmt(task.deadline)}\n`;
      if (r.notes.length) reply += `\nℹ️ ${esc(r.notes.join("; "))}\n`;
      if (r.workload) reply += `\n${r.workload.text}\n`;
      reply += `\n${empStateLine(r)}`;

      if (inGroup) return ctx.reply(reply, HTML);
      const kb = ceoTaskKeyboard(task.id);
      if (r.workload?.alt) {
        kb.row().text(`👥 Передать: ${empName(r.workload.alt)}`.slice(0, 60), `reto_${task.id}_${r.workload.alt.telegram_id}`);
      }
      return ctx.reply(reply, { ...HTML, reply_markup: kb });
    }

    // ── Несколько задач ──
    const { msg, kb } = renderMulti(results);
    await ctx.reply(msg, { ...HTML, reply_markup: kb });
  } catch (err) {
    console.error("processTaskCreation error:", err);
    await ctx.api
      .editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Не удалось обработать сообщение. ${explainAIError(err)}`)
      .catch(() => {});
  }
}

// ═════════════════════════════ ИИ-действия по задачам ═════════════════════════════
async function cancelTask(task) {
  const upd = await pool.query(
    `UPDATE tasks SET status = 'cancelled', extension_requested = FALSE
     WHERE id = $1 AND status NOT IN ('completed', 'cancelled') RETURNING id`,
    [task.id]
  );
  if (upd.rows.length === 0) return false;
  await pool.query(`DELETE FROM user_states WHERE task_id = $1`, [task.id]);
  const empId = await resolveAssigneeId(task);
  if (empId) {
    await safeSend(empId, `🚫 <b>Задача #${task.id} отменена руководителем.</b>\n📝 ${esc(task.task_title)}\nДелать её больше не нужно.`);
  }
  return true;
}

async function reopenTask(task) {
  if (task.status !== "completed") return false;
  await pool.query(`UPDATE tasks SET status = 'in_progress', completed_at = NULL, ai_review = NULL WHERE id = $1`, [task.id]);
  const empId = await resolveAssigneeId(task);
  if (empId) {
    await safeSend(empId, `↩️ <b>Руководитель вернул задачу #${task.id} на доработку.</b>\n\n${taskBody(task)}`, {
      reply_markup: empKeyboard(task.id, false),
    });
  }
  return true;
}

async function reassignTask(task, emp) {
  if (isClosed(task)) return null;
  const oldId = await resolveAssigneeId(task);
  const upd = await pool.query(
    `UPDATE tasks SET assignee_username = $1, assignee_telegram_id = $2,
       status = CASE WHEN status = 'in_progress' THEN 'pending' ELSE status END,
       notified_expired = FALSE, reminder_sent = FALSE, escalated = FALSE, risk_notified = FALSE, extension_requested = FALSE
     WHERE id = $3 RETURNING *`,
    [emp.username || emp.first_name, emp.telegram_id, task.id]
  );
  await pool.query(`DELETE FROM user_states WHERE task_id = $1`, [task.id]);
  const nt = upd.rows[0];
  if (oldId && oldId !== emp.telegram_id) {
    await safeSend(oldId, `👥 Задача #${task.id} передана другому сотруднику. Делать её больше не нужно.\n📝 ${esc(task.task_title)}`);
  }
  if (isAway(emp)) {
    await safeSend(CEO_ID, `🏖 ${esc(empName(emp))} сейчас в отпуске до ${fmtDate(emp.away_until)} — уведомление по #${task.id} не отправлено.`);
  } else {
    await notifyEmployeeNewTask(nt, emp.telegram_id);
  }
  return nt;
}

async function nudgeEmployee(task) {
  const empId = await resolveAssigneeId(task);
  if (!empId) return false;
  const m = await safeSend(empId, `🔔 <b>Напоминание от руководителя</b>\n\n${taskBody(task)}`, {
    reply_markup: empKeyboard(task.id, task.status === "pending"),
  });
  return !!m;
}

// Поиск задач по сотруднику и/или ключевым словам
async function findTasks({ user, hint, completed = false }) {
  const statusSql = completed ? `status = 'completed'` : `status NOT IN ('completed','cancelled')`;
  let rows = [];
  if (user) {
    const emp = await lookupEmployee(user);
    const names = [...new Set([user, emp?.username, emp?.first_name].filter(Boolean).map((s) => s.toLowerCase()))];
    let r = await pool.query(
      `SELECT * FROM tasks WHERE ${statusSql} AND (LOWER(assignee_username) = ANY($1::text[]) OR assignee_telegram_id = $2)
       ORDER BY deadline LIMIT 30`,
      [names, emp?.telegram_id ?? null]
    );
    rows = r.rows;
    if (!rows.length) {
      r = await pool.query(`SELECT * FROM tasks WHERE ${statusSql} AND assignee_username ILIKE $1 ORDER BY deadline LIMIT 30`, [`%${user}%`]);
      rows = r.rows;
    }
  } else if (hint) {
    rows = (await pool.query(`SELECT * FROM tasks WHERE ${statusSql} ORDER BY id DESC LIMIT 60`)).rows;
  }
  if (hint && rows.length) {
    const words = hint
      .toLowerCase()
      .split(/[\s,.;:!?«»"()]+/)
      .filter((w) => w.length >= 4)
      .map((w) => w.slice(0, Math.max(4, w.length - 2)));
    if (words.length) {
      const f = rows.filter((t) => words.some((w) => String(t.task_title).toLowerCase().includes(w)));
      if (!user) rows = f;
      else if (f.length) rows = f;
    }
  }
  return rows;
}

const confirmKb = (token) =>
  new InlineKeyboard().text("✅ Выполнить", `ay_${token}`).text("❌ Отмена", `an_${token}`);

function describeAction(a, tasks) {
  const list =
    tasks.slice(0, 8).map((t) => `• <b>#${t.id}</b> ${esc(assigneeLabel(t))} — ${esc(t.task_title)}`).join("\n") +
    (tasks.length > 8 ? `\n… и ещё ${tasks.length - 8}` : "");
  switch (a.type) {
    case "reschedule": return `📅 <b>Перенести срок на ${fmt(a.deadline)}?</b>\n${list}`;
    case "extend": return `⏱ <b>Продлить срок${a.deadline ? ` до ${fmt(a.deadline)}` : " на 24 часа"}?</b>\n${list}`;
    case "cancel": return `🗑 <b>Отменить ${tasks.length > 1 ? tasks.length + " задач" : "задачу"}?</b>\n${list}`;
    case "remind": return `🔔 <b>Напомнить исполнителю?</b>\n${list}`;
    case "reopen": return `↩️ <b>Вернуть на доработку?</b>\n${list}`;
    case "reassign": return `👥 <b>Передать ${esc(a.to_user)}?</b>\n${list}`;
    case "priority": return `${PRIO_LABEL[a.priority] || "Обычный приоритет"} — <b>изменить приоритет?</b>\n${list}`;
    case "depends": return `⛓ <b>Начинать после задачи #${a.after_task}?</b>\n${list}`;
    default: return list;
  }
}

async function startAction(ctx, a) {
  if (!a) return ctx.reply("🤔 Не понял, что нужно сделать.");

  // Отпуск сотрудника
  if (a.type === "away" || a.type === "back") {
    if (!a.user) return ctx.reply("🤔 Не понял, о каком сотруднике речь.");
    const emp = await lookupEmployee(a.user);
    if (!emp) return ctx.reply(`⚠️ Сотрудник «${a.user}» не найден среди зарегистрированных.`);
    if (a.type === "away" && (!a.until || a.until.getTime() <= Date.now())) {
      return ctx.reply("🤔 Не понял, до какой даты сотрудник недоступен. Скажите, например: «Ержан в отпуске до 20 декабря».");
    }
    const token = putPending(pendingActions, { a, targetIds: [], empId: emp.telegram_id });
    const text =
      a.type === "away"
        ? `🏖 <b>${esc(empName(emp))} в отпуске до ${fmtDate(a.until)}?</b>\nНапоминания ему приходить не будут, при постановке задач я предупрежу вас.`
        : `✅ <b>${esc(empName(emp))} снова на работе?</b>`;
    return ctx.reply(text, { ...HTML, reply_markup: confirmKb(token) });
  }

  // Проверка параметров
  if (a.type === "reschedule" && (!a.deadline || a.deadline.getTime() <= Date.now())) {
    return ctx.reply("🤔 Не понял новый срок или он уже прошёл. Скажите, например: «Перенеси задачу #12 на пятницу 15:00».");
  }
  if (a.type === "priority" && !a.priority) return ctx.reply("🤔 Не понял, какой приоритет поставить (срочно / важно / обычный).");
  if (a.type === "depends" && !a.after_task) return ctx.reply("🤔 Не понял, после какой задачи. Скажите, например: «Задача #5 после #4».");
  if (a.type === "reassign") {
    if (!a.to_user) return ctx.reply("🤔 Не понял, кому передать задачу.");
    const to = await lookupEmployee(a.to_user);
    if (!to) return ctx.reply(`⚠️ Сотрудник «${a.to_user}» не найден среди зарегистрированных.`);
  }

  // Поиск целей
  let targets = [];
  if (a.task_id) {
    const t = await getTask(a.task_id);
    if (t) targets = [t];
  } else if (a.user || a.hint) {
    targets = await findTasks({ user: a.user, hint: a.hint, completed: a.type === "reopen" });
  } else {
    return ctx.reply("🤔 Не понял, к какой задаче это относится. Назовите номер (#N) или сотрудника.");
  }
  targets = targets.filter((t) => (a.type === "reopen" ? t.status === "completed" : !isClosed(t)));
  if (!targets.length) return ctx.reply("🔍 Подходящих задач не нашёл.");

  const token = putPending(pendingActions, { a, targetIds: targets.map((t) => t.id) });

  if (a.scope === "all" || targets.length === 1) {
    return ctx.reply(describeAction(a, targets), { ...HTML, reply_markup: confirmKb(token) });
  }

  // Несколько кандидатов — просим выбрать
  const kb = new InlineKeyboard();
  targets.slice(0, 8).forEach((t) => kb.text(`#${t.id} ${String(t.task_title).slice(0, 28)}`, `ap_${token}_${t.id}`).row());
  if (["cancel", "remind", "reschedule", "extend"].includes(a.type)) kb.text(`Все (${targets.length})`, `ap_${token}_all`).row();
  kb.text("❌ Отмена", `an_${token}`);
  return ctx.reply(`🔎 <b>Нашёл несколько задач (${targets.length}). Какую выбрать?</b>`, { ...HTML, reply_markup: kb });
}

async function applyActionToTask(a, t) {
  const tag = `#${t.id}`;
  switch (a.type) {
    case "reschedule":
    case "extend": {
      if (isClosed(t)) return `⚠️ ${tag}: задача уже закрыта`;
      const upd = await pool.query(
        `UPDATE tasks SET deadline = COALESCE($1::timestamptz, GREATEST(deadline, now()) + INTERVAL '24 hours'),
           extension_requested = FALSE, notified_expired = FALSE, reminder_sent = FALSE, escalated = FALSE, risk_notified = FALSE
         WHERE id = $2 RETURNING deadline`,
        [a.deadline ? a.deadline.toISOString() : null, t.id]
      );
      const dl = upd.rows[0].deadline;
      const empId = await resolveAssigneeId(t);
      if (empId) await safeSend(empId, `⏱ Руководитель изменил срок по задаче #${t.id}. Новый срок: ${fmt(dl)}\n📝 ${esc(t.task_title)}`);
      return `✅ ${tag}: новый срок ${fmt(dl)}`;
    }
    case "cancel":
      return (await cancelTask(t)) ? `🗑 ${tag}: отменена` : `⚠️ ${tag}: уже закрыта`;
    case "remind":
      return (await nudgeEmployee(t)) ? `🔔 ${tag}: напоминание отправлено` : `⚠️ ${tag}: у исполнителя нет Telegram (/start)`;
    case "reopen":
      return (await reopenTask(t)) ? `↩️ ${tag}: возвращена на доработку` : `⚠️ ${tag}: задача не в статусе «выполнена»`;
    case "reassign": {
      const to = await lookupEmployee(a.to_user);
      if (!to) return `⚠️ ${tag}: сотрудник не найден`;
      const nt = await reassignTask(t, to);
      return nt ? `👥 ${tag}: передана ${esc(empName(to))}` : `⚠️ ${tag}: задача уже закрыта`;
    }
    case "priority": {
      await pool.query(`UPDATE tasks SET priority = $1 WHERE id = $2`, [a.priority, t.id]);
      if (a.priority === "urgent") {
        const empId = await resolveAssigneeId(t);
        if (empId) await safeSend(empId, `🔥 <b>Задача #${t.id} теперь СРОЧНАЯ.</b>\n📝 ${esc(t.task_title)}`);
      }
      return `✅ ${tag}: приоритет — ${PRIO_LABEL[a.priority] || "обычный"}`;
    }
    case "depends": {
      if (a.after_task === t.id) return `⚠️ ${tag}: задача не может зависеть от самой себя`;
      const dep = await getTask(a.after_task);
      if (!dep) return `⚠️ ${tag}: задача #${a.after_task} не найдена`;
      await pool.query(`UPDATE tasks SET depends_on = $1 WHERE id = $2`, [a.after_task, t.id]);
      return `⛓ ${tag}: начнётся после #${a.after_task}`;
    }
    default:
      return `⚠️ ${tag}: неизвестное действие`;
  }
}

async function executeAction(p) {
  const a = p.a;
  if (a.type === "away" || a.type === "back") {
    const r = await pool.query(`SELECT telegram_id, username, first_name FROM employees WHERE telegram_id = $1`, [p.empId]);
    const emp = r.rows[0];
    if (!emp) return "⚠️ Сотрудник не найден.";
    if (a.type === "back") {
      await pool.query(`UPDATE employees SET away_until = NULL WHERE telegram_id = $1`, [emp.telegram_id]);
      return `✅ ${esc(empName(emp))} снова на работе.`;
    }
    await pool.query(`UPDATE employees SET away_until = $1 WHERE telegram_id = $2`, [a.until.toISOString(), emp.telegram_id]);
    const act = await findTasks({ user: emp.username || emp.first_name });
    return (
      `🏖 ${esc(empName(emp))} в отпуске до ${fmtDate(a.until)}.` +
      (act.length ? `\nУ него(неё) ${act.length} активных задач — их можно передать: /tasks ${esc(emp.username || emp.first_name)}` : "")
    );
  }
  const out = [];
  for (const id of p.targetIds) {
    const t = await getTask(id);
    if (!t) {
      out.push(`⚠️ #${id}: не найдена`);
      continue;
    }
    try {
      out.push(await applyActionToTask(a, t));
    } catch (e) {
      console.error("applyActionToTask:", e);
      out.push(`❌ #${id}: ошибка`);
    }
  }
  return out.join("\n");
}

// ═════════════════════════════ Протокол совещания и разбор материалов ═════════════════════════════
const PRIO_ICON_ONLY = { urgent: "🔥", important: "⭐", normal: "" };

async function runProposal(ctx, { mediaParts = [], text = "", kind = "material", hint = "" }) {
  const wait = await ctx.reply(kind === "meeting" ? "🎧 Анализирую совещание и готовлю протокол..." : "🔍 Разбираю материал...");
  try {
    const { nowLocalIso, weekday, staffList } = await aiHeader();
    const prompt = `Сейчас ${nowLocalIso} (${weekday}), часовой пояс UTC+5 (Астана).
Список сотрудников: ${staffList || "пусто"}.
${kind === "meeting" ? "Это запись или расшифровка совещания руководителя." : "Это материал (письмо, переписка, скриншот, документ, фото или пересланное сообщение), из которого нужно выделить поручения."}
${hint ? `Комментарий руководителя: """${hint}"""\n` : ""}${text ? `Материал:\n"""${text.slice(0, 15000)}"""\n` : ""}
Верни JSON строго такого вида:
{"summary": "краткое резюме на 2-5 предложений", "decisions": ["принятое решение", "..."],
 "tasks": [{"title": "...", "user": "...", "deadline_iso": "...", "priority": "normal", "project": null, "recurrence": null}]}

Правила:
- Включай в tasks только конкретные поручения (что сделать и, по возможности, кто). Не выдумывай того, чего нет в материале. Не больше 15 задач.
- decisions — принятые решения и договорённости (если есть), не больше 7.
- Пиши по-русски.
${TASK_RULES}`;

    const contents = mediaParts.length ? [{ role: "user", parts: [...mediaParts, { text: prompt }] }] : prompt;
    const raw = await gen(contents, { json: true, media: mediaParts.length > 0 });
    const parsed = parseJSONLoose(raw);
    const items = (Array.isArray(parsed.tasks) ? parsed.tasks : []).slice(0, 15).map(normAiTask).filter((t) => t.title);
    const summary = String(parsed.summary || "").trim();
    const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : []).map((d) => String(d).trim()).filter(Boolean).slice(0, 7);

    let msg = kind === "meeting" ? "📋 <b>Протокол совещания</b>\n\n" : "🔍 <b>Что нашёл в материале</b>\n\n";
    if (summary) msg += `${esc(summary.slice(0, 900))}\n\n`;
    if (decisions.length) msg += "<b>Решения:</b>\n" + decisions.map((d) => `• ${esc(d.slice(0, 200))}`).join("\n") + "\n\n";

    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    if (!items.length) {
      return ctx.reply(msg + "Поручений не нашёл. Если нужно — напишите задачу сообщением.", HTML);
    }

    msg += `<b>Предлагаю задачи (${items.length}):</b>\n`;
    items.forEach((it, i) => {
      const when = it.recurrence ? describeRule(it.recurrence) : it.deadline ? fmt(it.deadline) : "срок не указан (+24 ч)";
      msg += `${i + 1}. ${PRIO_ICON_ONLY[it.priority]} <b>${esc(it.user || "без исполнителя")}</b> — ${esc(it.title)}\n   ⏰ ${esc(when)}${it.project ? ` · 📁 ${esc(it.project)}` : ""}\n`;
    });
    const token = putPending(pendingProposals, { items });
    const kb = new InlineKeyboard().text(`✅ Создать все (${items.length})`, `pm_all_${token}`).text("❌ Отмена", `pm_no_${token}`);
    await ctx.reply(msg.slice(0, 4000), { ...HTML, reply_markup: kb });
  } catch (err) {
    console.error("runProposal error:", err);
    await ctx.api
      .editMessageText(ctx.chat.id, wait.message_id, `❌ Не удалось разобрать материал. ${explainAIError(err)}`)
      .catch(() => {});
  }
}

async function handleCeoMaterial(ctx, { fileId, mime, size, caption }) {
  if (size && size > MAX_INLINE_BYTES) return ctx.reply("⚠️ Файл слишком большой (лимит около 14 МБ).");
  if (!/^(image\/|application\/pdf|text\/plain)/i.test(mime || "")) {
    return ctx.reply("⚠️ Умею разбирать фото, скриншоты, PDF и текстовые файлы (.txt).");
  }
  let buf;
  try {
    buf = await downloadTgFile(fileId);
  } catch (e) {
    console.error("download material:", e.message);
    return ctx.reply("❌ Не удалось скачать файл из Telegram.");
  }
  return runProposal(ctx, {
    mediaParts: [{ inlineData: { mimeType: mime, data: buf.toString("base64") } }],
    kind: "material",
    hint: caption || "",
  });
}

async function handleMeetingAudio(ctx, { fileId, mime, size }) {
  if (size && size > MAX_INLINE_BYTES) {
    return ctx.reply("⚠️ Запись слишком большая (лимит около 14 МБ). Разделите её на части или сожмите.");
  }
  let buf;
  try {
    buf = await downloadTgFile(fileId);
  } catch (e) {
    console.error("download meeting audio:", e.message);
    return ctx.reply("❌ Не удалось скачать запись из Telegram (лимит Telegram для ботов — 20 МБ).");
  }
  return runProposal(ctx, {
    mediaParts: [{ inlineData: { mimeType: mime, data: buf.toString("base64") } }],
    kind: "meeting",
  });
}

function forwardName(msg) {
  const o = msg.forward_origin;
  if (o) {
    if (o.type === "user" && o.sender_user) return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ");
    if (o.type === "hidden_user") return o.sender_user_name;
    if (o.chat) return o.chat.title || "чата";
  }
  if (msg.forward_from) return msg.forward_from.first_name;
  return msg.forward_sender_name || "неизвестного отправителя";
}

// ═════════════════════════════ Вопросы боту ═════════════════════════════
async function answerQuestion(ctx, question) {
  const wait = await ctx.reply("🔎 Смотрю данные...");
  try {
    const rows = await pool.query(
      `SELECT t.id, t.task_title, t.assignee_username, t.status, t.deadline, t.created_at, t.completed_at,
              t.report_text, t.ai_review, t.priority, t.project, e.first_name
       FROM tasks t ${TASK_EMP_JOIN}
       WHERE t.created_at >= now() - interval '90 days' OR t.status NOT IN ('completed', 'cancelled')
       ORDER BY t.id DESC LIMIT 200`
    );
    const lines = rows.rows.map(
      (t) =>
        `#${t.id} | ${t.first_name || assigneeLabel(t)} | ${STATUS_RU[t.status] || t.status} | срок ${fmt(t.deadline)} | создана ${fmt(t.created_at)}` +
        (t.completed_at ? ` | закрыта ${fmt(t.completed_at)}` : "") +
        (t.priority && t.priority !== "normal" ? ` | приоритет ${t.priority}` : "") +
        (t.project ? ` | проект ${t.project}` : "") +
        ` | ${t.task_title}` +
        (t.report_text ? ` | отчёт: ${String(t.report_text).slice(0, 120)}` : "") +
        (t.ai_review ? ` | оценка ИИ: ${t.ai_review}` : "")
    );
    const emps = await pool.query(`SELECT first_name, username, away_until FROM employees WHERE telegram_id != $1`, [CEO_ID]);
    const staff = emps.rows
      .map((e) => `${e.first_name || ""}${e.username ? " (@" + e.username + ")" : ""}${isAway(e) ? ` [в отпуске до ${fmtDate(e.away_until)}]` : ""}`.trim())
      .join("; ");

    const answer = await gen(
      `Ты — ассистент руководителя компании ${COMPANY_NAME}. Сейчас ${fmt(new Date())} (Астана).
Сотрудники: ${staff || "нет"}.
Задачи (от новых к старым):
${lines.join("\n") || "задач нет"}

Вопрос руководителя: """${question}"""

Ответь по-русски, кратко (до 10 строк), по делу и только на основании данных выше. Если данных не хватает — так и скажи. Не используй markdown-разметку (** и #), можно эмодзи и маркеры «•». Номера задач пиши как #N. Просроченной считай задачу, не выполненную и не отменённую, у которой срок раньше текущего времени.`
    );
    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    await ctx.reply(esc(answer || "Не удалось сформулировать ответ.").slice(0, 3800), HTML);
  } catch (err) {
    console.error("answerQuestion error:", err);
    await ctx.api
      .editMessageText(ctx.chat.id, wait.message_id, `❌ Не получилось ответить на вопрос. ${explainAIError(err)} Можно открыть /tasks.`)
      .catch(() => {});
  }
}

// Защита: тяжёлая команда не запускается повторно, пока не закончился предыдущий запуск
const inFlight = new Set();
function guarded(key, fn) {
  return async (ctx) => {
    if (inFlight.has(key)) return ctx.reply("⏳ Уже готовлю, подождите немного.");
    inFlight.add(key);
    try {
      return await fn(ctx);
    } finally {
      inFlight.delete(key);
    }
  };
}

// ═════════════════════════════ ИИ-брифинг ═════════════════════════════
async function generateBrief(kind) {
  const now = new Date();
  const p = localParts(now);
  const todayStart = localToUtc(p.y, p.mo, p.d, 0, 0);
  const tomorrowStart = new Date(todayStart.getTime() + 86400000);
  const afterTomorrow = new Date(todayStart.getTime() + 2 * 86400000);
  const ACTIVE = `status NOT IN ('completed', 'cancelled')`;

  const [counts, overdue, dueToday, dueTomorrow, doneToday, incomplete] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE ${ACTIVE}) AS active,
              COUNT(*) FILTER (WHERE ${ACTIVE} AND deadline < $1) AS overdue,
              COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= $2) AS done_today,
              COUNT(*) FILTER (WHERE created_at >= $2) AS created_today
       FROM tasks`,
      [now, todayStart]
    ),
    pool.query(`SELECT id, task_title, assignee_username, deadline, priority FROM tasks WHERE ${ACTIVE} AND deadline < $1 ORDER BY deadline LIMIT 8`, [now]),
    pool.query(`SELECT id, task_title, assignee_username, deadline, priority FROM tasks WHERE ${ACTIVE} AND deadline >= $1 AND deadline < $2 ORDER BY deadline LIMIT 10`, [now, tomorrowStart]),
    pool.query(`SELECT id, task_title, assignee_username, deadline, priority FROM tasks WHERE ${ACTIVE} AND deadline >= $1 AND deadline < $2 ORDER BY deadline LIMIT 10`, [tomorrowStart, afterTomorrow]),
    pool.query(`SELECT id, task_title, assignee_username FROM tasks WHERE status = 'completed' AND completed_at >= $1 ORDER BY completed_at DESC LIMIT 10`, [todayStart]),
    pool.query(`SELECT id, task_title, assignee_username, ai_review FROM tasks WHERE status = 'completed' AND completed_at >= $1 AND ai_review LIKE 'incomplete%' LIMIT 5`, [todayStart]),
  ]);

  const c = counts.rows[0];
  const lite = (r) => ({
    id: r.id, task: r.task_title, who: assigneeLabel(r),
    deadline: r.deadline ? fmt(r.deadline) : undefined,
    review: r.ai_review || undefined,
    priority: r.priority && r.priority !== "normal" ? r.priority : undefined,
  });
  const data = {
    now: fmt(now),
    active: Number(c.active),
    overdue_total: Number(c.overdue),
    done_today: Number(c.done_today),
    created_today: Number(c.created_today),
    overdue: overdue.rows.map(lite),
    due_today: dueToday.rows.map(lite),
    due_tomorrow: dueTomorrow.rows.map(lite),
    completed_today: doneToday.rows.map(lite),
    reports_flagged_incomplete: incomplete.rows.map(lite),
  };

  const goal =
    kind === "morning" ? "утренний брифинг: что важно сегодня"
    : kind === "evening" ? "вечерние итоги дня и что горит завтра"
    : "краткую сводку по состоянию задач прямо сейчас";

  try {
    const text = await gen(
      `Ты — ассистент руководителя компании ${COMPANY_NAME}. Составь ${goal}.
Данные (JSON): ${JSON.stringify(data)}

Требования: по-русски, 5–9 строк, по делу, без markdown-разметки (без ** и #), можно эмодзи и маркеры «•». Называй исполнителей и номера задач (#N). Выдели то, что требует внимания руководителя (срочные — в первую очередь). В конце — одна короткая рекомендация. Не выдумывай данных.`
    );
    if (text) return text;
  } catch (e) {
    console.error("brief AI error:", e.message);
  }

  // Запасной вариант без ИИ
  let t = `📊 Активных задач: ${data.active}, просрочено: ${data.overdue_total}. Закрыто сегодня: ${data.done_today}, создано сегодня: ${data.created_today}.`;
  if (data.overdue.length) t += "\n🔴 Просрочены:\n" + data.overdue.map((x) => `• #${x.id} ${x.who} — ${x.task}`).join("\n");
  if (data.due_today.length) t += "\n⏰ Сегодня к сроку:\n" + data.due_today.map((x) => `• #${x.id} ${x.who} — ${x.task} (${x.deadline})`).join("\n");
  return t;
}

// ─── Голосовой брифинг (TTS) ───
function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function runFfmpeg(bin, pcm) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0",
      "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1",
    ]);
    const chunks = [];
    let errTxt = "";
    p.stdout.on("data", (c) => chunks.push(c));
    p.stderr.on("data", (c) => (errTxt += c));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 && chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exit ${code}: ${errTxt.slice(0, 200)}`))
    );
    p.stdin.on("error", () => {});
    p.stdin.end(pcm);
  });
}

// PCM -> OGG/Opus (нужен пакет ffmpeg-static или ffmpeg в системе); иначе null
async function pcmToOgg(pcm) {
  const bins = [];
  try {
    const m = await import("ffmpeg-static");
    if (m.default) bins.push(m.default);
  } catch {
    /* пакет не установлен */
  }
  bins.push("ffmpeg");
  for (const b of bins) {
    try {
      return await runFfmpeg(b, pcm);
    } catch (e) {
      console.warn("ffmpeg:", e.message);
    }
  }
  return null;
}

function speechText(text) {
  return String(text)
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/#(\d+)/g, "номер $1")
    .replace(/[•*_`]/g, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 1100);
}

async function synthesizeSpeech(text) {
  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ role: "user", parts: [{ text: `Say calmly and warmly in Russian, like a personal assistant: ${text}` }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
    },
  });
  const part = response.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data);
  if (!part) throw new Error("TTS: нет аудио в ответе");
  return Buffer.from(part.inlineData.data, "base64");
}

async function sendVoiceBrief(chatId, text) {
  if (!VOICE_BRIEF) return false;
  try {
    const pcm = await synthesizeSpeech(speechText(text));
    const ogg = await pcmToOgg(pcm);
    if (ogg) {
      await bot.api.sendVoice(chatId, new InputFile(ogg, "brief.ogg"));
    } else {
      await bot.api.sendAudio(chatId, new InputFile(pcmToWav(pcm), "brief.wav"), { title: "Брифинг" });
    }
    return true;
  } catch (e) {
    console.error("voice brief:", e.message);
    return false;
  }
}

async function sendBrief(kind) {
  const text = await generateBrief(kind);
  const title = kind === "morning" ? "🌅 <b>Утренний брифинг</b>" : kind === "evening" ? "🌆 <b>Вечерние итоги</b>" : "📊 <b>Брифинг</b>";
  await safeSend(CEO_ID, `${title}\n\n${esc(text).slice(0, 3800)}`);
  if (kind === "morning") await sendVoiceBrief(CEO_ID, `Доброе утро, ${CEO_NAME}. ${text}`);
}

bot.command("brief", guarded("brief", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  const wait = await ctx.reply("🧠 Готовлю брифинг...");
  try {
    const text = await generateBrief("manual");
    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    await ctx.reply(`📊 <b>Брифинг</b>\n\n${esc(text).slice(0, 3800)}`, HTML);
  } catch (e) {
    console.error("brief error:", e);
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Не удалось подготовить брифинг. ${explainAIError(e)}`).catch(() => {});
  }
}));

bot.command("voice", guarded("voice", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  if (!VOICE_BRIEF) return ctx.reply("🔇 Голосовой брифинг выключен (VOICE_BRIEF=off).");
  const wait = await ctx.reply("🎙 Готовлю голосовой брифинг...");
  try {
    const text = await generateBrief("manual");
    const ok = await sendVoiceBrief(CEO_ID, `${CEO_NAME}, ${text}`);
    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    if (!ok) await ctx.reply(`❌ Не удалось озвучить. Вот текст:\n\n${esc(text).slice(0, 3500)}`, HTML);
  } catch (e) {
    console.error("voice cmd:", e);
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Не удалось подготовить брифинг. ${explainAIError(e)}`).catch(() => {});
  }
}));

// ═════════════════════════════ Статистика и индекс надёжности ═════════════════════════════
function parseDaysArg(ctx, def = 30) {
  const n = parseInt(String(ctx.match || "").trim(), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 365) : def;
}

// Окно: задачи, созданные от fromDays до toDays дней назад
async function computeStats(fromDays, toDays = 0) {
  const r = await pool.query(
    `SELECT LOWER(COALESCE(NULLIF(t.assignee_username, ''), 'не назначен')) AS who,
       COUNT(*) FILTER (WHERE t.status <> 'cancelled') AS total,
       COUNT(*) FILTER (WHERE t.status = 'completed') AS done,
       COUNT(*) FILTER (WHERE t.status = 'completed' AND t.completed_at IS NOT NULL AND t.completed_at <= t.deadline) AS ontime,
       COUNT(*) FILTER (WHERE t.status = 'completed' AND t.completed_at IS NOT NULL) AS done_timed,
       COUNT(*) FILTER (WHERE t.status NOT IN ('completed', 'cancelled') AND t.deadline < now()) AS overdue,
       COUNT(*) FILTER (WHERE t.status = 'cancelled') AS cancelled,
       COUNT(*) FILTER (WHERE t.ai_review IS NOT NULL) AS rv_all,
       COUNT(*) FILTER (WHERE t.ai_review LIKE 'complete%') AS rv_ok,
       AVG(EXTRACT(EPOCH FROM (t.completed_at - t.created_at)))
         FILTER (WHERE t.status = 'completed' AND t.completed_at IS NOT NULL AND t.created_at IS NOT NULL) AS avg_sec
     FROM tasks t
     WHERE t.created_at >= now() - make_interval(days => $1::int)
       AND t.created_at < now() - make_interval(days => $2::int)
     GROUP BY 1 ORDER BY done DESC, total DESC`,
    [fromDays, toDays]
  );
  return r.rows;
}

// Индекс надёжности 0–100: в срок 40%, выполнение 25%, отсутствие просрочек 20%, качество отчётов (оценка ИИ) 15%
function reliability(x) {
  const total = Number(x.total), done = Number(x.done), timed = Number(x.done_timed);
  const ontime = Number(x.ontime), overdue = Number(x.overdue), rvAll = Number(x.rv_all), rvOk = Number(x.rv_ok);
  if (total === 0) return null;
  const onT = timed > 0 ? ontime / timed : 0.7;
  const comp = done / total;
  const od = 1 - Math.min(1, overdue / total);
  const rv = rvAll > 0 ? rvOk / rvAll : 0.7;
  return Math.round(100 * (0.4 * onT + 0.25 * comp + 0.2 * od + 0.15 * rv));
}
const scoreIcon = (s) => (s === null ? "⚪" : s >= 80 ? "🟢" : s >= 60 ? "🟡" : "🔴");
const trendLabel = (cur, prev) =>
  cur === null || prev === null || prev === undefined
    ? ""
    : cur > prev ? ` ▲ +${cur - prev}` : cur < prev ? ` ▼ −${prev - cur}` : " =";

bot.command("stats", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  const days = parseDaysArg(ctx);
  try {
    const [rows, prevRows] = await Promise.all([computeStats(days, 0), computeStats(days * 2, days)]);
    if (rows.length === 0) return ctx.reply(`📭 За последние ${days} дн. задач нет.`);
    const prevMap = new Map(prevRows.map((x) => [x.who, reliability(x)]));

    let msg = `📈 <b>Статистика за ${days} дн.</b>\n\n`;
    let tTotal = 0, tDone = 0, tOntime = 0, tTimed = 0, tOverdue = 0;
    for (const x of rows) {
      tTotal += Number(x.total); tDone += Number(x.done); tOntime += Number(x.ontime);
      tTimed += Number(x.done_timed); tOverdue += Number(x.overdue);
      const sc = reliability(x);
      msg += `👤 <b>${esc(assigneeLabel({ assignee_username: x.who }))}</b>\n`;
      if (sc !== null) msg += `   ${scoreIcon(sc)} Индекс надёжности: <b>${sc}/100</b>${trendLabel(sc, prevMap.get(x.who))}\n`;
      msg += `   Выполнено: ${x.done} из ${x.total} (${pct(x.done, x.total)})\n`;
      msg += `   В срок: ${x.ontime} из ${x.done_timed} (${pct(x.ontime, x.done_timed)})\n`;
      msg += `   Просрочено сейчас: ${x.overdue}${Number(x.cancelled) ? ` · отменено: ${x.cancelled}` : ""}\n`;
      msg += `   Среднее время закрытия: ${fmtDuration(x.avg_sec)}\n\n`;
    }
    msg += `<b>Итого:</b> выполнено ${tDone} из ${tTotal} (${pct(tDone, tTotal)}), в срок ${pct(tOntime, tTimed)}, просрочено сейчас ${tOverdue}.\n`;
    msg += `<i>Индекс = в срок 40% + выполнение 25% + без просрочек 20% + качество отчётов 15%. Стрелка — к предыдущему периоду такой же длины. Период: /stats 7, /stats 90</i>`;
    await ctx.reply(msg.slice(0, 4000), HTML);
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Не удалось собрать статистику.");
  }
});

// ═════════════════════════════ Недельный отчёт (HTML) ═════════════════════════════
async function buildWeeklyReport() {
  const [cur, prev] = await Promise.all([computeStats(7, 0), computeStats(14, 7)]);
  const prevMap = new Map(prev.map((x) => [x.who, reliability(x)]));
  const sum = (arr, k) => arr.reduce((a, x) => a + Number(x[k]), 0);
  const total = sum(cur, "total"), done = sum(cur, "done"), ontime = sum(cur, "ontime"), timed = sum(cur, "done_timed");
  const prevTotal = sum(prev, "total"), prevDone = sum(prev, "done");

  const overdue = (
    await pool.query(
      `SELECT id, task_title, assignee_username, deadline FROM tasks
       WHERE status NOT IN ('completed','cancelled') AND deadline < now() ORDER BY deadline LIMIT 15`
    )
  ).rows;
  const doneList = (
    await pool.query(
      `SELECT id, task_title, assignee_username, completed_at FROM tasks
       WHERE status = 'completed' AND completed_at >= now() - interval '7 days' ORDER BY completed_at DESC LIMIT 12`
    )
  ).rows;

  const people = cur.map((x) => ({ who: assigneeLabel({ assignee_username: x.who }), score: reliability(x), prevScore: prevMap.get(x.who), x }));

  // Выводы: сначала ИИ, при сбое — простые правила
  let insights = [];
  try {
    const raw = await gen(
      `Ты — аналитик руководителя компании ${COMPANY_NAME}. Данные недели (JSON): ${JSON.stringify({
        created: total, done, ontime_of_done: `${ontime}/${timed}`, prev_week: { created: prevTotal, done: prevDone },
        overdue_now: overdue.length,
        people: people.map((p) => ({ who: p.who, score: p.score, prev: p.prevScore ?? null, done: p.x.done, total: p.x.total, overdue: p.x.overdue })),
      })}
Верни JSON: {"insights": ["вывод 1", "вывод 2", "вывод 3"]} — 3 коротких делового вывода по-русски (до 140 символов каждый), с конкретикой и одной рекомендацией. Не выдумывай данных.`,
      { json: true }
    );
    insights = (Array.isArray(parseJSONLoose(raw).insights) ? parseJSONLoose(raw).insights : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 4);
  } catch (e) {
    console.error("weekly insights AI:", e.message);
  }
  if (!insights.length) {
    const best = [...people].filter((p) => p.score !== null).sort((a, b) => b.score - a.score)[0];
    const worst = [...people].sort((a, b) => Number(b.x.overdue) - Number(a.x.overdue))[0];
    if (best) insights.push(`Лучший результат недели — ${best.who} (индекс ${best.score}/100).`);
    if (worst && Number(worst.x.overdue) > 0) insights.push(`Больше всего просрочек у ${worst.who}: ${worst.x.overdue}. Стоит обсудить нагрузку.`);
    insights.push(`Выполнено ${done} из ${total} задач (${pct(done, total)}), в срок — ${pct(ontime, timed)}.`);
  }

  const delta = (a, b) => (b > 0 ? (a >= b ? `▲ ${a - b}` : `▼ ${b - a}`) + " к прошлой неделе" : "");
  const from = fmtDate(new Date(Date.now() - 6 * 86400000));
  const to = fmtDate(new Date());
  const stamp = todayKey();

  const bars = people
    .map((p) => {
      const w = p.score ?? 0;
      const color = w >= 80 ? "#2e9d57" : w >= 60 ? "#e0a800" : "#d64545";
      return `<div class="row"><div class="who">${esc(p.who)}</div><div class="bar"><span style="width:${w}%;background:${color}"></span></div><div class="val">${p.score ?? "—"}${esc(trendLabel(p.score, p.prevScore))}</div><div class="sub">${p.x.done}/${p.x.total} · просрочено ${p.x.overdue}</div></div>`;
    })
    .join("") || `<p class="muted">За неделю задач нет.</p>`;

  const li = (arr, f) => (arr.length ? `<ul>${arr.map(f).join("")}</ul>` : `<p class="muted">Нет</p>`);

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Отчёт недели — ${esc(COMPANY_NAME)}</title>
<style>
:root{--bg:#f4f6fb;--card:#fff;--tx:#1d2433;--mut:#6b7488;--ac:#1f4e78}
@media (prefers-color-scheme:dark){:root{--bg:#10141c;--card:#19202c;--tx:#e8ecf4;--mut:#93a0b8;--ac:#7fb2e5}}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--tx)}
.wrap{max-width:860px;margin:0 auto;padding:24px 16px 48px}
h1{margin:0 0 4px;font-size:26px;color:var(--ac)}h2{font-size:18px;margin:28px 0 10px}
.muted{color:var(--mut)}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:18px}
.kpi{background:var(--card);border-radius:14px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.kpi b{display:block;font-size:30px;color:var(--ac)}.kpi small{color:var(--mut)}
.card{background:var(--card);border-radius:14px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.row{display:grid;grid-template-columns:140px 1fr 90px;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(128,128,128,.15)}
.row:last-child{border-bottom:0}.who{font-weight:600}.bar{height:12px;background:rgba(128,128,128,.2);border-radius:8px;overflow:hidden}
.bar span{display:block;height:100%}.val{font-weight:700;text-align:right}.sub{grid-column:2/4;color:var(--mut);font-size:13px;margin-top:-4px}
ul{margin:0;padding-left:20px}li{margin:6px 0}.foot{margin-top:28px;color:var(--mut);font-size:12px}
@media(max-width:560px){.row{grid-template-columns:100px 1fr 70px}}
</style></head><body><div class="wrap">
<h1>Отчёт недели</h1>
<div class="muted">${esc(COMPANY_NAME)} · ${esc(from)} — ${esc(to)}</div>
<div class="kpis">
<div class="kpi"><b>${total}</b><small>создано задач<br>${esc(delta(total, prevTotal))}</small></div>
<div class="kpi"><b>${done}</b><small>выполнено (${pct(done, total)})<br>${esc(delta(done, prevDone))}</small></div>
<div class="kpi"><b>${pct(ontime, timed)}</b><small>закрыто в срок</small></div>
<div class="kpi"><b>${overdue.length}</b><small>просрочено сейчас</small></div>
</div>
<h2>Выводы</h2><div class="card">${li(insights, (s) => `<li>${esc(s)}</li>`)}</div>
<h2>Индекс надёжности сотрудников</h2><div class="card">${bars}</div>
<h2>Выполнено за неделю</h2><div class="card">${li(doneList, (t) => `<li><b>#${t.id}</b> ${esc(assigneeLabel(t))} — ${esc(t.task_title)} <span class="muted">(${esc(fmt(t.completed_at))})</span></li>`)}</div>
<h2>Просрочено сейчас</h2><div class="card">${li(overdue, (t) => `<li><b>#${t.id}</b> ${esc(assigneeLabel(t))} — ${esc(t.task_title)} <span class="muted">(срок был ${esc(fmt(t.deadline))})</span></li>`)}</div>
<div class="foot">Сформировано ботом ${esc(COMPANY_NAME)} · ${esc(fmt(new Date()))}. Чтобы сохранить в PDF: откройте файл в браузере и выберите «Печать → Сохранить как PDF».</div>
</div></body></html>`;

  return { html, filename: `weekly_report_${stamp}.html`, caption: `📈 Отчёт недели: создано ${total}, выполнено ${done} (${pct(done, total)}), просрочено сейчас ${overdue.length}.` };
}

async function sendWeeklyReport(chatId) {
  const r = await buildWeeklyReport();
  await bot.api.sendDocument(chatId, new InputFile(Buffer.from(r.html, "utf8"), r.filename), { caption: r.caption });
}

bot.command("weekly", guarded("weekly", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  const wait = await ctx.reply("📈 Собираю отчёт недели...");
  try {
    await sendWeeklyReport(ctx.chat.id);
    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
  } catch (e) {
    console.error("weekly error:", e);
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, "❌ Не удалось собрать отчёт.").catch(() => {});
  }
}));

// ═════════════════════════════ Выгрузка в Excel ═════════════════════════════
bot.command("export", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  const days = parseDaysArg(ctx);
  const wait = await ctx.reply("📊 Готовлю файл...");
  try {
    const r = await pool.query(
      `SELECT t.*, e.first_name FROM tasks t ${TASK_EMP_JOIN}
       WHERE t.created_at >= now() - make_interval(days => $1::int) ORDER BY t.id`,
      [days]
    );
    if (r.rows.length === 0) {
      return ctx.api.editMessageText(ctx.chat.id, wait.message_id, `📭 За последние ${days} дн. задач нет.`);
    }

    const header = ["№", "Задача", "Исполнитель", "Статус", "Приоритет", "Проект", "Создана", "Срок", "Закрыта", "В срок", "Отчёт", "Оценка ИИ"];
    const data = r.rows.map((t) => [
      t.id,
      t.task_title,
      t.first_name || assigneeLabel(t),
      STATUS_RU[t.status] || t.status,
      PRIO_LABEL[t.priority] || "обычный",
      t.project || "",
      t.created_at ? fmt(t.created_at) : "",
      fmt(t.deadline),
      t.completed_at ? fmt(t.completed_at) : "",
      t.status === "completed" && t.completed_at ? (new Date(t.completed_at) <= new Date(t.deadline) ? "да" : "нет") : "",
      t.report_text || "",
      t.ai_review || "",
    ]);
    const stamp = todayKey();
    let file;
    let caption = `📊 Задачи за ${days} дн.: ${r.rows.length} шт.`;

    let ExcelJS = null;
    try {
      ExcelJS = (await import("exceljs")).default;
    } catch {
      ExcelJS = null;
    }

    if (ExcelJS) {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Задачи", { views: [{ state: "frozen", ySplit: 1 }] });
      const widths = [6, 45, 24, 14, 14, 20, 20, 20, 20, 9, 50, 40];
      ws.columns = header.map((h, i) => ({ header: h, key: `c${i}`, width: widths[i] }));
      data.forEach((row) => ws.addRow(row));
      ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
      ws.autoFilter = { from: "A1", to: "L1" };
      const fills = { "выполнена": "FFE2F0D9", "отменена": "FFEDEDED", "в работе": "FFFFF2CC" };
      ws.eachRow((row, n) => {
        row.alignment = { vertical: "top", wrapText: true };
        if (n === 1) return;
        const color = fills[String(row.getCell(4).value)];
        if (color) row.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
      });
      const buf = await wb.xlsx.writeBuffer();
      file = new InputFile(Buffer.from(buf), `oilan_tasks_${stamp}.xlsx`);
    } else {
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = "\uFEFF" + [header, ...data].map((row) => row.map(q).join(";")).join("\r\n");
      file = new InputFile(Buffer.from(csv, "utf8"), `oilan_tasks_${stamp}.csv`);
      caption += "\n(CSV: чтобы получать .xlsx, добавьте пакет exceljs в package.json)";
    }

    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    await ctx.replyWithDocument(file, { caption });
  } catch (e) {
    console.error("export error:", e);
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, "❌ Не удалось сформировать файл.").catch(() => {});
  }
});

// ═════════════════════════════ Повторяющиеся задачи ═════════════════════════════
bot.command("recurring", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  try {
    const r = await pool.query(`SELECT * FROM recurring_tasks WHERE active ORDER BY id`);
    if (r.rows.length === 0) {
      return ctx.reply(
        "🔁 Повторяющихся задач пока нет.\n\nСоздайте обычным сообщением, например:\n«Каждый понедельник до 10:00 Ержану отчёт по продажам»"
      );
    }
    let msg = "🔁 <b>Повторяющиеся задачи:</b>\n\n";
    const kb = new InlineKeyboard();
    r.rows.forEach((x, i) => {
      msg += `<b>R${x.id}</b> | ${esc(assigneeLabel(x))}\n📝 ${esc(x.title)}\n📅 ${esc(describeRule(x))}, срок до ${x.due_time}\n\n`;
      kb.text(`🗑 Удалить R${x.id}`, `rec_del_${x.id}`);
      if (i % 2 === 1) kb.row();
    });
    await ctx.reply(msg, { ...HTML, reply_markup: kb });
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Не удалось загрузить список.");
  }
});

async function spawnRecurring(now) {
  const p = localParts(now);
  if (p.h < SPAWN_HOUR) return;
  const today = todayKey(now);
  const isoWd = p.wd;
  const dim = new Date(Date.UTC(p.y, p.mo + 1, 0)).getUTCDate();

  const recs = await pool.query(`SELECT * FROM recurring_tasks WHERE active AND last_run_day IS DISTINCT FROM $1`, [today]);
  for (const r of recs.rows) {
    if (!ruleMatches(r, isoWd, p.d, dim)) continue;

    const claim = await pool.query(
      `UPDATE recurring_tasks SET last_run_day = $1 WHERE id = $2 AND last_run_day IS DISTINCT FROM $1 RETURNING id`,
      [today, r.id]
    );
    if (claim.rows.length === 0) continue;

    const [hh, mm] = r.due_time.split(":").map(Number);
    const deadline = localToUtc(p.y, p.mo, p.d, hh, mm);
    if (deadline <= now) {
      await safeSend(CEO_ID, `ℹ️ Повтор R${r.id} («${esc(r.title)}») пропущен: срок на сегодня (${r.due_time}) уже прошёл.`);
      continue;
    }

    const empId = await resolveAssigneeId(r);
    const ins = await pool.query(
      `INSERT INTO tasks (task_title, assignee_username, assignee_telegram_id, creator_telegram_id, deadline, status, recurring_id, priority, project)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8) RETURNING *`,
      [r.title, r.assignee_username, empId, CEO_ID, deadline.toISOString(), r.id, r.priority || "normal", r.project || null]
    );
    const task = ins.rows[0];
    let sent = null;
    if (empId) {
      const er = await pool.query(`SELECT away_until FROM employees WHERE telegram_id = $1`, [empId]);
      if (!isAway(er.rows[0])) sent = await notifyEmployeeNewTask(task, empId);
    }
    await safeSend(
      CEO_ID,
      `🔁 <b>Создана повторяющаяся задача #${task.id}</b>\n👤 ${esc(assigneeLabel(task))}\n📝 ${esc(task.task_title)}\n⏰ ${fmt(task.deadline)}\n` +
        (sent ? "✅ Сотрудник уведомлён." : "⚠️ Сотрудник не получил уведомление (нет /start или в отпуске).")
    );
  }
}

// ═════════════════════════════ План по шагам (чек-лист) ═════════════════════════════
async function generatePlan(task) {
  const raw = await gen(
    `Разбей рабочую задачу на 3–7 коротких конкретных шагов, которые поможет выполнить сотруднику.
Задача: """${task.task_title}"""
Верни JSON: {"steps": ["шаг 1", "шаг 2", ...]}. Каждый шаг — одно короткое действие (до 100 символов), по-русски, без нумерации.`,
    { json: true }
  );
  const parsed = parseJSONLoose(raw);
  const steps = (Array.isArray(parsed.steps) ? parsed.steps : [])
    .map((s) => String(s).replace(/^\s*\d+[.)]\s*/, "").trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 7);
  if (steps.length < 2) throw new Error("plan too short");
  return steps.map((t) => ({ t, done: false }));
}

function renderChecklist(task) {
  const steps = task.checklist || [];
  const done = steps.filter((s) => s.done).length;
  let text = `🧩 <b>План по задаче #${task.id}</b>\n📝 ${esc(task.task_title)}\n\n`;
  steps.forEach((s, i) => {
    text += `${s.done ? "☑" : "☐"} ${i + 1}. ${esc(s.t)}\n`;
  });
  text += `\nВыполнено: ${done}/${steps.length}`;
  const kb = new InlineKeyboard();
  steps.forEach((s, i) => {
    kb.text(`${s.done ? "☑" : "☐"} ${i + 1}`, `chk_${task.id}_${i}`);
    if ((i + 1) % 4 === 0) kb.row();
  });
  return { text, kb };
}

// ═════════════════════════════ Отчёты ═════════════════════════════
async function reviewReport(task, report, filesCount) {
  const raw = await gen(
    `Ты проверяешь отчёт сотрудника о выполнении рабочей задачи.
Задача: """${task.task_title}"""
Отчёт сотрудника: """${String(report).slice(0, 2000)}"""
Приложено файлов: ${filesCount}.
Оцени, закрывает ли отчёт задачу. Верни JSON: {"verdict": "complete" | "incomplete" | "unclear", "comment": "одно короткое предложение: чего не хватает или почему всё в порядке"}.`,
    { json: true }
  );
  const p = parseJSONLoose(raw);
  const verdict = ["complete", "incomplete", "unclear"].includes(p.verdict) ? p.verdict : "unclear";
  return { verdict, comment: String(p.comment || "").slice(0, 300) };
}

async function sendFileToCEO(f, caption) {
  const opts = { caption, parse_mode: "HTML" };
  try {
    if (f.file_type === "photo") return await bot.api.sendPhoto(CEO_ID, f.file_id, opts);
    if (f.file_type === "video") return await bot.api.sendVideo(CEO_ID, f.file_id, opts);
    return await bot.api.sendDocument(CEO_ID, f.file_id, opts);
  } catch (e) {
    console.error("sendFileToCEO:", e.message);
    return null;
  }
}

// Зависимые задачи: когда закрыта #N, исполнитель следующей получает сигнал
async function notifyDependents(doneId) {
  try {
    const r = await pool.query(`SELECT * FROM tasks WHERE depends_on = $1 AND status NOT IN ('completed','cancelled')`, [doneId]);
    for (const d of r.rows) {
      const empId = await resolveAssigneeId(d);
      if (empId) {
        await safeSend(empId, `⛓ <b>Можно приступать!</b> Задача #${doneId} закрыта, теперь доступна ваша задача #${d.id}.\n\n${taskBody(d)}`, {
          reply_markup: empKeyboard(d.id, d.status === "pending"),
        });
      }
      await safeSend(CEO_ID, `⛓ Задача #${doneId} закрыта — запущена зависимая #${d.id} (${esc(assigneeLabel(d))}).`);
    }
  } catch (e) {
    console.error("notifyDependents:", e.message);
  }
}

async function finalizeReport(ctx, userId, task, reportText) {
  await clearState(userId);
  await pool.query(
    `UPDATE tasks SET status = 'completed', report_text = $1, completed_at = now() WHERE id = $2`,
    [reportText, task.id]
  );
  await ctx.reply(`🎉 Задача #${task.id} успешно закрыта с отчётом!`);

  const filesRes = await pool.query(`SELECT * FROM task_files WHERE task_id = $1 AND sent IS NOT TRUE ORDER BY id`, [task.id]);

  let reviewLine = "";
  let verdict = null;
  try {
    const rv = await reviewReport(task, reportText, filesRes.rows.length);
    verdict = rv.verdict;
    await pool.query(`UPDATE tasks SET ai_review = $1 WHERE id = $2`, [`${rv.verdict}: ${rv.comment}`, task.id]);
    const icon = rv.verdict === "complete" ? "✅" : rv.verdict === "incomplete" ? "⚠️" : "❔";
    const label = rv.verdict === "complete" ? "отчёт закрывает задачу" : rv.verdict === "incomplete" ? "отчёт неполный" : "сложно оценить";
    reviewLine = `\n\n${icon} <b>Оценка ИИ:</b> ${label}${rv.comment ? ` — ${esc(rv.comment)}` : ""}`;
  } catch (e) {
    console.error("AI review:", e.message);
  }

  // Похвала: закрыто заранее (минимум за час) и отчёт не признан неполным
  if (verdict !== "incomplete" && new Date(task.deadline).getTime() - Date.now() >= 3600000) {
    await ctx.reply("🙌 Отлично! Задача закрыта раньше срока. Так держать!").catch(() => {});
  }

  const shown = String(reportText).length > 3000 ? String(reportText).slice(0, 3000) + "…" : String(reportText);
  await safeSend(
    CEO_ID,
    `🟢 <b>Задача #${task.id} выполнена!</b>\n👤 ${esc(assigneeLabel(task))}\n📝 ${esc(task.task_title)}\n\n<b>Отчёт сотрудника:</b>\n${esc(shown)}` +
      (filesRes.rows.length ? `\n\n📎 Файлов: ${filesRes.rows.length}` : "") +
      reviewLine,
    { reply_markup: new InlineKeyboard().text("↩️ Вернуть на доработку", `ceo_reopen_${task.id}`) }
  );
  for (const f of filesRes.rows.slice(0, 10)) {
    await sendFileToCEO(f, `📎 К задаче #${task.id}${f.caption ? ": " + esc(f.caption) : ""}`);
  }
  await pool.query(`UPDATE task_files SET sent = TRUE WHERE task_id = $1`, [task.id]);
  await notifyDependents(task.id);
}

// Файлы и фото: от сотрудника — вложение к отчёту; от CEO — материал для разбора
async function handleAttachment(ctx, fileId, type, mime, size) {
  const userId = String(ctx.from.id);
  if (ctx.chat.type !== "private" && userId !== CEO_ID) return;

  if (userId === CEO_ID) {
    if (type === "video") return ctx.reply("🎬 Видео разобрать не могу. Пришлите фото, скриншот, PDF или аудио.");
    if (takeMeetingMode() && /^audio\//i.test(mime || "")) return handleMeetingAudio(ctx, { fileId, mime, size });
    return handleCeoMaterial(ctx, { fileId, mime, size, caption: ctx.message.caption?.trim() || "" });
  }

  const state = await getState(userId);
  if (!state || state.action !== "waiting_report") {
    return ctx.reply("📎 Чтобы приложить файл к отчёту, сначала нажмите «✅ Завершить» у нужной задачи.");
  }
  const task = await getTask(state.task_id);
  if (!task) return ctx.reply("⚠️ Задача не найдена.");
  if (task.status === "cancelled") {
    await clearState(userId);
    return ctx.reply("🚫 Эта задача была отменена руководителем.");
  }
  if (!isAssignee(task, ctx.from)) return ctx.reply("⚠️ Эта задача вам не назначена.");

  const caption = ctx.message.caption?.trim() || null;
  await pool.query(
    `INSERT INTO task_files (task_id, file_id, file_type, caption) VALUES ($1, $2, $3, $4)`,
    [task.id, fileId, type, caption]
  );
  if (caption) return finalizeReport(ctx, userId, task, caption);

  const cnt = await pool.query(`SELECT COUNT(*) AS n FROM task_files WHERE task_id = $1 AND sent IS NOT TRUE`, [task.id]);
  await ctx.reply(`📎 Файл прикреплён (${cnt.rows[0].n}). Отправьте ещё файлы или напишите текст отчёта — им завершится задача.`);
}

bot.on("message:photo", (ctx) => handleAttachment(ctx, ctx.message.photo.at(-1).file_id, "photo", "image/jpeg", ctx.message.photo.at(-1).file_size));
bot.on("message:document", (ctx) => handleAttachment(ctx, ctx.message.document.file_id, "document", ctx.message.document.mime_type, ctx.message.document.file_size));
bot.on("message:video", (ctx) => handleAttachment(ctx, ctx.message.video.file_id, "video", ctx.message.video.mime_type, ctx.message.video.file_size));

// ═════════════════════════════ Текстовые сообщения ═════════════════════════════
bot.on("message:text", async (ctx) => {
  const userId = String(ctx.from.id);
  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  const inGroup = ctx.chat.type !== "private";

  // 1. Ждём отчёт, причину отсрочки или комментарий?
  const state = inGroup ? null : await getState(userId);
  if (state) {
    const task = await getTask(state.task_id);
    await clearState(userId);

    if (!task) return ctx.reply("⚠️ Задача не найдена.");

    // Комментарий по задаче (и сотрудник, и руководитель)
    if (state.action === "waiting_comment") {
      const isC = userId === CEO_ID;
      if (!isC && !isAssignee(task, ctx.from)) return ctx.reply("⚠️ Эта задача вам не назначена.");
      await pool.query(`INSERT INTO task_comments (task_id, author_id, text) VALUES ($1, $2, $3)`, [task.id, userId, text.slice(0, 2000)]);
      const to = isC ? await resolveAssigneeId(task) : CEO_ID;
      if (!to) return ctx.reply("⚠️ Комментарий сохранён, но получателя в Telegram пока нет (сотрудник не нажал /start).");
      const who = isC ? CEO_NAME : `${ctx.from.first_name || ""}${ctx.from.username ? " (@" + ctx.from.username + ")" : ""}`.trim();
      const sent = await safeSend(
        to,
        `💬 <b>Комментарий по задаче #${task.id}</b> от ${esc(who)}\n📝 ${esc(task.task_title)}\n\n«${esc(text.slice(0, 1500))}»`,
        { reply_markup: new InlineKeyboard().text("💬 Ответить", `cm_${task.id}`) }
      );
      return ctx.reply(sent ? "✅ Отправлено." : "⚠️ Сохранил, но доставить не удалось.");
    }

    if (task.status === "cancelled") return ctx.reply("🚫 Эта задача была отменена руководителем.");
    if (!isAssignee(task, ctx.from)) return ctx.reply("⚠️ Эта задача вам не назначена.");

    if (state.action === "waiting_report") {
      return finalizeReport(ctx, userId, task, text);
    }

    if (state.action === "waiting_extension") {
      await pool.query(`UPDATE tasks SET extension_requested = TRUE WHERE id = $1`, [task.id]);
      await ctx.reply("⏱ Запрос на отсрочку отправлен руководителю.");
      const kb = new InlineKeyboard()
        .text("✅ Разрешить (+1 день)", `ceo_approve_${task.id}`)
        .text("❌ Отказать", `ceo_reject_${task.id}`);
      const who = `${ctx.from.first_name || ""}${ctx.from.username ? " (@" + ctx.from.username + ")" : ""}`.trim();
      await safeSend(
        CEO_ID,
        `⏱ <b>Запрос отсрочки по задаче #${task.id}</b>\n📝 ${esc(task.task_title)}\n⏰ Текущий срок: ${fmt(task.deadline)}\n👤 От: ${esc(who)}\n💬 Причина: «${esc(text)}»`,
        { reply_markup: kb }
      );
      return;
    }
  }

  // 2. Обычный текст не от CEO — отклоняем
  if (userId !== CEO_ID) {
    return ctx.reply("⚠️ У вас нет прав на постановку задач.");
  }

  // 3. Сообщение CEO
  const assign = getCeoAssign(userId);
  if (assign) ceoAssign.delete(userId);

  if (!inGroup && !assign) {
    const meeting = takeMeetingMode();
    const fwd = ctx.message.forward_origin || ctx.message.forward_date;
    if (fwd) {
      return runProposal(ctx, {
        text: `Пересланное сообщение от ${forwardName(ctx.message)}:\n${text}`,
        kind: meeting ? "meeting" : "material",
      });
    }
    if (meeting || text.length >= MEETING_TEXT_CHARS) {
      return runProposal(ctx, { text, kind: "meeting" });
    }
  }
  await processTaskCreation(ctx, text, assign?.emp || null, null, inGroup);
});

// ═════════════════════════════ Голосовые и аудио ═════════════════════════════
bot.on("message:voice", async (ctx) => {
  const userId = String(ctx.from.id);
  if (ctx.chat.type !== "private") return;

  // Сотрудник наговаривает отчёт
  if (userId !== CEO_ID) {
    const state = await getState(userId);
    if (!state || state.action !== "waiting_report") return;
    const task = await getTask(state.task_id);
    if (!task || !isAssignee(task, ctx.from)) return;
    if (task.status === "cancelled") {
      await clearState(userId);
      return ctx.reply("🚫 Эта задача была отменена руководителем.");
    }
    const wait = await ctx.reply("🎙 Расшифровываю голосовой отчёт...");
    try {
      const buf = await downloadTgFile(ctx.message.voice.file_id);
      const transcript = await transcribeAudio(buf, "audio/ogg");
      await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
      if (!transcript) return ctx.reply("❌ Не удалось распознать речь. Напишите отчёт текстом.");
      return finalizeReport(ctx, userId, task, `🎙 (голосовой отчёт) ${transcript}`);
    } catch (err) {
      console.error("Employee voice error:", err);
      return ctx.api.editMessageText(ctx.chat.id, wait.message_id, "❌ Не удалось обработать голосовое. Напишите отчёт текстом.").catch(() => {});
    }
  }

  // CEO: длинное голосовое или режим /meeting — протокол совещания
  const v = ctx.message.voice;
  if (takeMeetingMode() || Number(v.duration) >= MEETING_SECONDS) {
    return handleMeetingAudio(ctx, { fileId: v.file_id, mime: "audio/ogg", size: v.file_size });
  }

  // CEO: обычное голосовое — расшифровка и разбор ОДНИМ запросом
  const msg = await ctx.reply("🎙 Слушаю...");
  try {
    if (v.file_size && v.file_size > MAX_INLINE_BYTES) throw new Error("file too large");
    const buf = await downloadTgFile(v.file_id);

    let parsed;
    try {
      parsed = await parseCEOMessage("", { audio: { buf, mime: "audio/ogg" } });
    } catch (e1) {
      console.error("Combined voice parse failed, fallback to separate STT:", e1.message);
      const transcript = await transcribeAudio(buf, "audio/ogg"); // Gemini ещё раз / Groq Whisper
      if (!transcript) throw e1;
      parsed = await parseCEOMessage(transcript);
    }

    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    if (!parsed.text) return ctx.reply("❌ Не удалось распознать речь. Попробуйте ещё раз.");
    await ctx.reply(`🎙 <b>Распознано:</b> «${esc(parsed.text)}»`, HTML);

    const assign = getCeoAssign(CEO_ID);
    if (assign) ceoAssign.delete(CEO_ID);
    await processTaskCreation(ctx, parsed.text, assign?.emp || null, parsed, false);
  } catch (err) {
    console.error("Voice processing error:", err);
    await ctx.api
      .editMessageText(ctx.chat.id, msg.message_id, `❌ Не удалось обработать голосовое сообщение.\nПричина: ${explainAIError(err)}`)
      .catch(() => {});
  }
});

bot.on("message:audio", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID || ctx.chat.type !== "private") return;
  ceoMeeting.delete(CEO_ID);
  const a = ctx.message.audio;
  let mime = a.mime_type || "audio/mpeg";
  if (/m4a|x-m4a/i.test(mime)) mime = "audio/mp4";
  return handleMeetingAudio(ctx, { fileId: a.file_id, mime, size: a.file_size });
});

// ═════════════════════════════ Кнопки ═════════════════════════════
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = String(ctx.from.id);
  const isCeo = userId === CEO_ID;
  const alertNo = (text) => ctx.answerCallbackQuery({ text, show_alert: true });
  // Отвечаем на сообщение, из которого пришла кнопка (в личке или группе)
  const say = (text, extra = {}) => ctx.reply(text, { ...HTML, ...extra });

  // ─── Выбор сотрудника из /staff ───
  const pick = data.match(/^pick_(\d+)$/);
  if (pick) {
    if (!isCeo) return alertNo("Нет прав");
    const r = await pool.query(`SELECT telegram_id, username, first_name FROM employees WHERE telegram_id = $1`, [pick[1]]);
    if (!r.rows[0]) return alertNo("Сотрудник не найден");
    const emp = r.rows[0];
    ceoAssign.set(CEO_ID, { emp, ts: Date.now() });
    await ctx.answerCallbackQuery();
    await say(
      `✍️ Задача для <b>${esc(emp.first_name || emp.username)}</b>.\n` +
        `Напишите текст или отправьте голосовое. Срок укажите в сообщении, например «до завтра 15:00». Отмена: /cancel`
    );
    return;
  }

  // ─── Удаление повторяющейся задачи ───
  const recDel = data.match(/^rec_del_(\d+)$/);
  if (recDel) {
    if (!isCeo) return alertNo("Нет прав");
    const r = await pool.query(`DELETE FROM recurring_tasks WHERE id = $1 RETURNING title`, [Number(recDel[1])]);
    if (r.rows.length === 0) return alertNo("Повтор уже удалён");
    await ctx.answerCallbackQuery("Повтор удалён");
    await say(`🗑 Повторяющаяся задача R${recDel[1]} удалена: «${esc(r.rows[0].title)}». Уже созданные задачи остались.`);
    return;
  }

  // ─── Карточка задачи ───
  const card = data.match(/^card_(\d+)$/);
  if (card) {
    if (!isCeo) return alertNo("Нет прав");
    await ctx.answerCallbackQuery();
    await sendTaskCard(ctx.chat.id, Number(card[1]));
    return;
  }

  // ─── Чек-лист: отметка шага ───
  const chk = data.match(/^chk_(\d+)_(\d+)$/);
  if (chk) {
    const id = Number(chk[1]), idx = Number(chk[2]);
    const task = await getTask(id);
    if (!task) return alertNo("Задача не найдена");
    if (!isAssignee(task, ctx.from)) return alertNo("Отмечать шаги может только исполнитель");
    if (task.status === "cancelled") return alertNo("🚫 Задача отменена руководителем");
    const steps = Array.isArray(task.checklist) ? task.checklist : [];
    if (!steps[idx]) return alertNo("Шаг не найден");
    steps[idx].done = !steps[idx].done;
    await pool.query(`UPDATE tasks SET checklist = $1::jsonb WHERE id = $2`, [JSON.stringify(steps), id]);
    task.checklist = steps;
    const { text, kb } = renderChecklist(task);
    await ctx.editMessageText(text, { ...HTML, reply_markup: kb }).catch(() => {});
    await ctx.answerCallbackQuery(
      steps.every((s) => s.done) ? "🎉 Все шаги выполнены — нажмите «Завершить» в карточке задачи" : undefined
    );
    return;
  }

  // ─── План по шагам (CEO или исполнитель) ───
  const plan = data.match(/^plan_(\d+)$/);
  if (plan) {
    const id = Number(plan[1]);
    const task = await getTask(id);
    if (!task) return alertNo("Задача не найдена");
    if (!isCeo && !isAssignee(task, ctx.from)) return alertNo("Эта задача назначена не вам");
    if (isClosed(task)) return alertNo("Задача уже закрыта");

    await ctx.answerCallbackQuery("🧩 Готовлю план...");
    let steps = Array.isArray(task.checklist) && task.checklist.length ? task.checklist : null;
    if (!steps) {
      try {
        steps = await generatePlan(task);
      } catch (e) {
        console.error("generatePlan:", e.message);
        return say(`❌ Не удалось составить план. ${isCeo ? explainAIError(e) : "ИИ временно недоступен, попробуйте позже."}`);
      }
      await pool.query(`UPDATE tasks SET checklist = $1::jsonb WHERE id = $2`, [JSON.stringify(steps), id]);
      task.checklist = steps;
    }
    const target = isCeo ? (await resolveAssigneeId(task)) || CEO_ID : userId;
    const { text, kb } = renderChecklist(task);
    await safeSend(target, text, { reply_markup: kb });
    if (isCeo && target !== CEO_ID) await say(`🧩 План по задаче #${id} отправлен сотруднику.`);
    return;
  }

  // ─── ИИ-действия: подтверждение / отмена / выбор задачи ───
  const ay = data.match(/^(ay|an)_([a-f0-9]{8})$/);
  if (ay) {
    if (!isCeo) return alertNo("Нет прав");
    const p = getPending(pendingActions, ay[2]);
    if (!p) {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
      return alertNo("Действие устарело. Повторите команду.");
    }
    pendingActions.delete(ay[2]); // защита от двойного нажатия
    if (ay[1] === "an") {
      await ctx.answerCallbackQuery("Отменено");
      await ctx.editMessageText("↩️ Действие отменено.").catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery("Выполняю…");
    const result = await executeAction(p);
    const edited = await ctx.editMessageText(result.slice(0, 4000), HTML).then(() => true).catch(() => false);
    if (!edited) await say(result.slice(0, 4000));
    return;
  }

  const ap = data.match(/^ap_([a-f0-9]{8})_(\d+|all)$/);
  if (ap) {
    if (!isCeo) return alertNo("Нет прав");
    const p = getPending(pendingActions, ap[1]);
    if (!p) return alertNo("Действие устарело. Повторите команду.");
    if (ap[2] !== "all") {
      const id = Number(ap[2]);
      if (!p.targetIds.includes(id)) return alertNo("Задача не из списка");
      p.targetIds = [id];
    }
    p.ts = Date.now();
    const tasks = [];
    for (const id of p.targetIds) {
      const t = await getTask(id);
      if (t) tasks.push(t);
    }
    await ctx.answerCallbackQuery();
    const txt = describeAction(p.a, tasks);
    const edited = await ctx.editMessageText(txt, { ...HTML, reply_markup: confirmKb(ap[1]) }).then(() => true).catch(() => false);
    if (!edited) await say(txt, { reply_markup: confirmKb(ap[1]) });
    return;
  }

  // ─── Протокол/материал: создать все предложенные задачи ───
  const pm = data.match(/^pm_(all|no)_([a-f0-9]{8})$/);
  if (pm) {
    if (!isCeo) return alertNo("Нет прав");
    const p = getPending(pendingProposals, pm[2]);
    if (!p) {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
      return alertNo("Предложение устарело. Пришлите материал ещё раз.");
    }
    pendingProposals.delete(pm[2]); // защита от двойного нажатия
    if (pm[1] === "no") {
      await ctx.answerCallbackQuery("Отменено");
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
      await say("↩️ Задачи не созданы.");
      return;
    }
    await ctx.answerCallbackQuery("Создаю задачи…");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    const results = [];
    for (const item of p.items) {
      try {
        results.push(await createOneTask(item, null));
      } catch (e) {
        console.error("createOneTask (proposal):", e);
        results.push({ kind: "error", title: item.title });
      }
    }
    const { msg, kb } = renderMulti(results);
    await say(msg, { reply_markup: kb });
    return;
  }

  // ─── Быстрые действия руководителя: напомнить / передать ───
  const remind = data.match(/^remind_(\d+)$/);
  if (remind) {
    if (!isCeo) return alertNo("Нет прав");
    const task = await getTask(Number(remind[1]));
    if (!task) return alertNo("Задача не найдена");
    if (isClosed(task)) return alertNo("Задача уже закрыта");
    const ok = await nudgeEmployee(task);
    return ok ? ctx.answerCallbackQuery("🔔 Напоминание отправлено") : alertNo("У исполнителя нет Telegram (не нажал /start)");
  }

  const re = data.match(/^re_(\d+)$/);
  if (re) {
    if (!isCeo) return alertNo("Нет прав");
    const task = await getTask(Number(re[1]));
    if (!task) return alertNo("Задача не найдена");
    if (isClosed(task)) return alertNo("Задача уже закрыта");
    const emps = await pool.query(
      `SELECT telegram_id, username, first_name, away_until FROM employees WHERE telegram_id != $1 ORDER BY first_name`,
      [CEO_ID]
    );
    if (!emps.rows.length) return alertNo("Нет зарегистрированных сотрудников");
    const kb = new InlineKeyboard();
    emps.rows.forEach((e, i) => {
      kb.text(`${isAway(e) ? "🏖 " : ""}${empName(e)}`.slice(0, 40), `reto_${task.id}_${e.telegram_id}`);
      if (i % 2 === 1) kb.row();
    });
    await ctx.answerCallbackQuery();
    await say(`👥 <b>Кому передать задачу #${task.id}?</b>\n📝 ${esc(task.task_title)}`, { reply_markup: kb });
    return;
  }

  const reto = data.match(/^reto_(\d+)_(\d+)$/);
  if (reto) {
    if (!isCeo) return alertNo("Нет прав");
    const task = await getTask(Number(reto[1]));
    if (!task) return alertNo("Задача не найдена");
    if (isClosed(task)) return alertNo("Задача уже закрыта");
    const er = await pool.query(`SELECT telegram_id, username, first_name, away_until FROM employees WHERE telegram_id = $1`, [reto[2]]);
    const emp = er.rows[0];
    if (!emp) return alertNo("Сотрудник не найден");
    const nt = await reassignTask(task, emp);
    if (!nt) return alertNo("Задача уже закрыта");
    await ctx.answerCallbackQuery("Передано");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    await say(`👥 Задача #${task.id} передана: <b>${esc(empName(emp))}</b>.`);
    return;
  }

  // ─── Комментарий по задаче (диалог руководитель ↔ сотрудник) ───
  const cm = data.match(/^cm_(\d+)$/);
  if (cm) {
    const task = await getTask(Number(cm[1]));
    if (!task) return alertNo("Задача не найдена");
    if (!isCeo && !isAssignee(task, ctx.from)) return alertNo("Эта задача назначена не вам");
    if (task.status === "cancelled") return alertNo("🚫 Задача отменена");
    if (ctx.chat.type !== "private") return alertNo("Напишите мне в личные сообщения");
    await setState(userId, "waiting_comment", task.id);
    await ctx.answerCallbackQuery();
    await say(`💬 Напишите сообщение по задаче #${task.id} — оно уйдёт ${isCeo ? "исполнителю" : "руководителю"}. Отмена: /cancel`);
    return;
  }

  // ─── Остальные действия по задаче ───
  const m = data.match(
    /^(emp_accept|emp_complete|emp_extend|ceo_approve|ceo_reject|ceo_cancel|ceo_cancelyes|ceo_cancelno|ceo_reopen|ceo_extend)_(\d+)$/
  );
  if (!m) return ctx.answerCallbackQuery();

  const action = m[1];
  const id = Number(m[2]);

  const task = await getTask(id);
  if (!task) return alertNo("Задача не найдена");

  // Проверка прав
  if (action.startsWith("ceo_")) {
    if (!isCeo) return alertNo("Нет прав");
  } else if (!isAssignee(task, ctx.from)) {
    return alertNo("Эта задача назначена не вам");
  }

  // Кнопки сотрудника на отменённой задаче больше не работают
  if (action.startsWith("emp_") && task.status === "cancelled") {
    return alertNo("🚫 Задача отменена руководителем");
  }

  // ─── Отмена задачи руководителем ───
  if (action === "ceo_cancel") {
    if (isClosed(task)) return alertNo(task.status === "completed" ? "Задача уже выполнена" : "Задача уже отменена");
    await ctx.answerCallbackQuery();
    await say(
      `❓ <b>Отменить задачу #${id}?</b>\n📝 ${esc(task.task_title)}\n👤 ${esc(assigneeLabel(task))}\n⏰ ${fmt(task.deadline)}`,
      {
        reply_markup: new InlineKeyboard()
          .text("✅ Да, отменить", `ceo_cancelyes_${id}`)
          .text("↩️ Нет", `ceo_cancelno_${id}`),
      }
    );
    return;
  }

  if (action === "ceo_cancelno") {
    await ctx.answerCallbackQuery("Отмена не выполнена");
    await ctx.editMessageText(`↩️ Задача #${id} оставлена без изменений.`).catch(() => {});
    return;
  }

  if (action === "ceo_cancelyes") {
    const ok = await cancelTask(task);
    if (!ok) {
      await ctx.answerCallbackQuery({ text: "Задачу уже нельзя отменить", show_alert: true });
      await ctx.editMessageText(`ℹ️ Задача #${id} уже выполнена или отменена.`).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery("Задача отменена");
    await ctx.editMessageText(`🚫 <b>Задача #${id} отменена.</b>\n📝 ${esc(task.task_title)}`, HTML).catch(() => {});
    return;
  }

  // ─── Вернуть выполненную задачу на доработку ───
  if (action === "ceo_reopen") {
    if (task.status !== "completed") return alertNo("Задача не в статусе «выполнена»");
    await reopenTask(task);
    await ctx.answerCallbackQuery("Возвращено на доработку");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    await say(`↩️ Задача #${id} возвращена сотруднику на доработку.`);
    return;
  }

  // ─── Руководитель сам продлевает срок (из эскалации) ───
  if (action === "ceo_extend") {
    if (isClosed(task)) return alertNo("Задача уже закрыта");
    const upd = await pool.query(
      `UPDATE tasks SET deadline = GREATEST(deadline, now()) + INTERVAL '24 hours',
         extension_requested = FALSE, notified_expired = FALSE, reminder_sent = FALSE, escalated = FALSE, risk_notified = FALSE
       WHERE id = $1 RETURNING deadline`,
      [id]
    );
    await ctx.answerCallbackQuery("Срок продлён на 24 часа");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    await say(`⏱ Срок задачи #${id} продлён до ${fmt(upd.rows[0].deadline)}.`);
    const empId = await resolveAssigneeId(task);
    if (empId) {
      await safeSend(empId, `⏱ Руководитель продлил срок по задаче #${id}. Новый срок: ${fmt(upd.rows[0].deadline)}`);
    }
    return;
  }

  // ─── Кнопки сотрудника ───
  if (action === "emp_accept") {
    if (task.status !== "pending") {
      return ctx.answerCallbackQuery({ text: task.status === "completed" ? "Задача уже завершена" : "Уже в работе" });
    }
    await pool.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [id]);
    await ctx.answerCallbackQuery("Задача принята в работу!");
    await ctx
      .editMessageText(`📬 <b>Ваша задача</b>\n\n${taskBody(task)}\n\n🟡 <b>Статус: В работе</b>`, {
        ...HTML,
        reply_markup: empKeyboard(id, false),
      })
      .catch(() => {});
    await safeSend(CEO_ID, `🔔 ${esc(assigneeLabel(task))} взял(а) в работу задачу #${id}: ${esc(task.task_title)}`);
  } else if (action === "emp_complete") {
    if (task.status === "completed") return ctx.answerCallbackQuery({ text: "Задача уже завершена" });
    await setState(userId, "waiting_report", id);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `📝 Напишите краткий отчёт по задаче #${id} (текстом или голосовым). Можно приложить фото или файл, затем отправить текст. Отмена: /cancel`
    );
  } else if (action === "emp_extend") {
    if (task.status === "completed") return ctx.answerCallbackQuery({ text: "Задача уже завершена" });
    if (task.extension_requested) return alertNo("Запрос уже отправлен, ждите ответа");
    await setState(userId, "waiting_extension", id);
    await ctx.answerCallbackQuery();
    await ctx.reply(`⏱ Напишите причину и на сколько нужно перенести дедлайн по задаче #${id}. Отмена: /cancel`);
  } else if (action === "ceo_approve") {
    if (!task.extension_requested) return ctx.answerCallbackQuery({ text: "Запрос уже обработан" });
    const upd = await pool.query(
      `UPDATE tasks SET deadline = GREATEST(deadline, now()) + INTERVAL '24 hours',
         extension_requested = FALSE, notified_expired = FALSE, reminder_sent = FALSE, escalated = FALSE, risk_notified = FALSE
       WHERE id = $1 RETURNING deadline`,
      [id]
    );
    const newDeadline = upd.rows[0].deadline;
    await ctx.answerCallbackQuery("Отсрочка одобрена (+24 часа)!");
    await ctx
      .editMessageText(
        `⏱ <b>Запрос отсрочки по задаче #${id}</b>\n📝 ${esc(task.task_title)}\n\n✅ <b>Одобрено.</b> Новый срок: ${fmt(newDeadline)}`,
        HTML
      )
      .catch(() => {});
    const empId = await resolveAssigneeId(task);
    if (empId) await safeSend(empId, `✅ Руководитель одобрил отсрочку по задаче #${id}. Новый срок: ${fmt(newDeadline)}`);
  } else if (action === "ceo_reject") {
    if (!task.extension_requested) return ctx.answerCallbackQuery({ text: "Запрос уже обработан" });
    await pool.query(`UPDATE tasks SET extension_requested = FALSE WHERE id = $1`, [id]);
    await ctx.answerCallbackQuery("Отсрочка отклонена.");
    await ctx
      .editMessageText(`⏱ <b>Запрос отсрочки по задаче #${id}</b>\n📝 ${esc(task.task_title)}\n\n❌ <b>Отклонено.</b>`, HTML)
      .catch(() => {});
    const empId = await resolveAssigneeId(task);
    if (empId) await safeSend(empId, `❌ Отсрочка по задаче #${id} отклонена. Срок прежний: ${fmt(task.deadline)}`);
  }
});

// ═════════════════════════════ Фоновый сторож ═════════════════════════════
let watcherBusy = false;

async function sendDigest() {
  const rows = await pool.query(
    `SELECT e.telegram_id, e.away_until, t.id, t.task_title, t.deadline, t.priority
     FROM tasks t ${TASK_EMP_JOIN}
     WHERE t.status NOT IN ('completed', 'cancelled') AND e.telegram_id IS NOT NULL
     ORDER BY e.telegram_id, t.deadline`
  );
  const byEmp = new Map();
  for (const r of rows.rows) {
    if (isAway(r)) continue;
    if (!byEmp.has(r.telegram_id)) byEmp.set(r.telegram_id, []);
    byEmp.get(r.telegram_id).push(r);
  }
  for (const [tgId, tasks] of byEmp) {
    let msg = "🌅 <b>Доброе утро! Ваш план задач:</b>\n\n";
    for (const t of tasks) msg += `• <b>#${t.id}</b>: ${prioIcon(t)}${esc(t.task_title)} (срок: ${fmt(t.deadline)})\n`;
    await safeSend(tgId, msg.slice(0, 4000));
  }
}

async function watcherTick() {
  if (watcherBusy) return;
  watcherBusy = true;
  try {
    const now = new Date();
    const nowISO = now.toISOString();
    const in15 = new Date(now.getTime() + 15 * 60000).toISOString();
    const ACTIVE = `t.status NOT IN ('completed', 'cancelled')`;
    sweepPending();

    // 1. Напоминание за 15 минут
    const upcoming = await pool.query(
      `SELECT t.id, t.task_title, t.priority, e.telegram_id, e.away_until
       FROM tasks t ${TASK_EMP_JOIN}
       WHERE t.deadline <= $1 AND t.deadline > $2 AND ${ACTIVE} AND t.reminder_sent IS NOT TRUE`,
      [in15, nowISO]
    );
    for (const t of upcoming.rows) {
      await sendToEmp(t, `⚠️ <b>Напоминание:</b> до дедлайна по задаче #${t.id} осталось менее 15 минут!\n\n📝 ${esc(t.task_title)}`);
      await pool.query(`UPDATE tasks SET reminder_sent = TRUE WHERE id = $1`, [t.id]);
    }

    // 1б. Предиктор рисков: задача может сорваться, пока срок ещё не наступил
    const risky = await pool.query(
      `SELECT t.id, t.task_title, t.assignee_username, t.status, t.deadline, t.created_at, t.checklist
       FROM tasks t
       WHERE ${ACTIVE} AND t.deadline > $1 AND t.risk_notified IS NOT TRUE AND t.created_at IS NOT NULL`,
      [nowISO]
    );
    for (const t of risky.rows) {
      const total = new Date(t.deadline).getTime() - new Date(t.created_at).getTime();
      const left = new Date(t.deadline).getTime() - now.getTime();
      if (total < 3 * 3600000 || left <= 15 * 60000) continue;
      const elapsed = 1 - left / total;
      let reason = null;
      if (t.status === "pending" && left <= Math.min(6 * 3600000, 0.3 * total)) {
        reason = "сотрудник ещё не взял задачу в работу";
      } else if (Array.isArray(t.checklist) && t.checklist.length >= 2) {
        const done = t.checklist.filter((s) => s.done).length;
        const ratio = done / t.checklist.length;
        if (elapsed >= 0.6 && ratio < elapsed - 0.3) {
          reason = `по плану выполнено ${done} из ${t.checklist.length}, а до срока ${fmtDuration(left / 1000)}`;
        }
      }
      if (!reason) continue;
      await safeSend(
        CEO_ID,
        `⚠️ <b>Риск срыва: задача #${t.id}</b>\n👤 ${esc(assigneeLabel(t))}\n📝 ${esc(t.task_title)}\n⏰ Срок: ${fmt(t.deadline)} (осталось ${fmtDuration(left / 1000)})\n❗ ${esc(reason)}`,
        {
          reply_markup: new InlineKeyboard()
            .text("🔔 Напомнить", `remind_${t.id}`)
            .text("👥 Передать", `re_${t.id}`)
            .row()
            .text("⏱ +1 день", `ceo_extend_${t.id}`),
        }
      );
      await pool.query(`UPDATE tasks SET risk_notified = TRUE WHERE id = $1`, [t.id]);
    }

    // 2. Просрочка
    const expired = await pool.query(
      `SELECT t.id, t.task_title, t.assignee_username, t.priority, e.telegram_id, e.away_until
       FROM tasks t ${TASK_EMP_JOIN}
       WHERE t.deadline <= $1 AND ${ACTIVE} AND t.notified_expired IS NOT TRUE`,
      [nowISO]
    );
    for (const t of expired.rows) {
      await sendToEmp(t, `⏰ <b>ВНИМАНИЕ! Дедлайн по задаче #${t.id} истёк!</b>\n\n📝 ${esc(t.task_title)}`);
      await safeSend(CEO_ID, `⚠️ <b>Просрочка: ${esc(assigneeLabel(t))}, задача #${t.id}</b>\n📝 ${esc(t.task_title)}`, {
        reply_markup: new InlineKeyboard().text("⚙️ Действия", `card_${t.id}`),
      });
      await pool.query(`UPDATE tasks SET notified_expired = TRUE WHERE id = $1`, [t.id]);
    }

    // 3. Эскалация: просрочка дольше ESCALATION_HOURS часов
    const cutoff = new Date(now.getTime() - ESCALATION_HOURS * 3600000).toISOString();
    const escalate = await pool.query(
      `SELECT t.id, t.task_title, t.assignee_username, t.deadline, t.priority, e.telegram_id, e.away_until
       FROM tasks t ${TASK_EMP_JOIN}
       WHERE t.deadline <= $1 AND ${ACTIVE} AND t.escalated IS NOT TRUE AND t.extension_requested IS NOT TRUE`,
      [cutoff]
    );
    for (const t of escalate.rows) {
      await sendToEmp(
        t,
        `🔥 <b>Задача #${t.id} просрочена более ${ESCALATION_HOURS} ч!</b>\n📝 ${esc(t.task_title)}\nСрок был: ${fmt(t.deadline)}\nЗакройте её или запросите отсрочку.`,
        { reply_markup: empKeyboard(t.id, false) }
      );
      await safeSend(
        CEO_ID,
        `🔥 <b>Эскалация:</b> ${esc(assigneeLabel(t))} не закрыл(а) задачу #${t.id} уже более ${ESCALATION_HOURS} ч после срока.\n📝 ${esc(t.task_title)}\nСрок был: ${fmt(t.deadline)}${isAway(t) ? "\n🏖 Сотрудник в отпуске." : ""}`,
        {
          reply_markup: new InlineKeyboard()
            .text("⏱ +1 день", `ceo_extend_${t.id}`)
            .text("🔔 Напомнить", `remind_${t.id}`)
            .row()
            .text("👥 Передать", `re_${t.id}`)
            .text("🗑 Отменить", `ceo_cancel_${t.id}`),
        }
      );
      await pool.query(`UPDATE tasks SET escalated = TRUE WHERE id = $1`, [t.id]);
    }

    // 4. Повторяющиеся задачи
    await spawnRecurring(now);

    // 5. Утренний дайджест, брифинги и недельный отчёт (один раз, переживает перезапуски)
    const p = localParts(now);
    const minutes = p.h * 60 + p.mi;
    const day = todayKey(now);
    if (minutes >= 9 * 60 && minutes < 12 * 60) {
      if (await claimDaily("digest", day)) await sendDigest();
      if (await claimDaily("brief_morning", day)) await sendBrief("morning");
    }
    if (minutes >= 18 * 60 && minutes < 21 * 60) {
      if (await claimDaily("brief_evening", day)) await sendBrief("evening");
    }
    if (p.wd === 5 && minutes >= 17 * 60 && minutes < 20 * 60) {
      if (await claimDaily("weekly_report", day)) await sendWeeklyReport(CEO_ID).catch((e) => console.error("weekly auto:", e.message));
    }
  } catch (err) {
    console.error("Ошибка в фоновом стороже:", err);
  } finally {
    watcherBusy = false;
  }
}

// ═════════════════════════════ Запуск ═════════════════════════════
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

async function main() {
  await initDB();
  await bot.init(); // нужно для ctx.me (упоминания в группах) и в webhook-режиме
  await setCommands().catch((e) => console.error("setCommands:", e.message));

  const app = express();
  app.use(express.json());
  app.get("/", (req, res) => res.send(`🤖 ${COMPANY_NAME} bot is running!`));

  if (BOT_MODE === "webhook") {
    const path = `/tg/${WEBHOOK_SECRET}`;
    // Отвечаем Telegram сразу (иначе при долгой обработке он шлёт обновление повторно),
    // а само обновление обрабатываем в фоне. Повторы отсекаем по update_id.
    const seenUpdates = new Set();
    app.post(path, (req, res) => {
      if (req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) return res.sendStatus(403);
      res.sendStatus(200);
      const id = req.body?.update_id;
      if (id !== undefined) {
        if (seenUpdates.has(id)) return;
        seenUpdates.add(id);
        if (seenUpdates.size > 3000) seenUpdates.delete(seenUpdates.values().next().value);
      }
      bot.handleUpdate(req.body).catch((e) => console.error("handleUpdate:", e?.error?.message || e?.message || e));
    });
  }

  app.listen(PORT, async () => {
    console.log(`🌐 Web server is listening on port ${PORT} (mode: ${BOT_MODE})`);

    try {
      if (BOT_MODE === "webhook") {
        await bot.api.setWebhook(`${RENDER_URL}/tg/${WEBHOOK_SECRET}`, {
          secret_token: WEBHOOK_SECRET,
          drop_pending_updates: false,
        });
        console.log("🔗 Webhook установлен");
      } else {
        await bot.api.deleteWebhook();
        bot.start({ onStart: () => console.log("📡 Long polling запущен") });
      }
    } catch (err) {
      console.error("Не удалось запустить бота:", err);
      process.exit(1);
    }

    // Авто-пинг против засыпания на Render Free Tier
    setInterval(() => {
      fetch(RENDER_URL)
        .then((r) => console.log(`🔄 Self-ping status: ${r.status}`))
        .catch((e) => console.error("Self-ping error:", e.message));
    }, 10 * 60 * 1000);
  });

  setInterval(watcherTick, 60000);
  console.log(`🤖 Ultimate Oilan Group Bot запущен! Модели ИИ: ${MODEL_CANDIDATES.join(" → ")}${process.env.GROQ_API_KEY ? " (+Groq)" : ""}`);
}

main().catch((e) => {
  console.error("Фатальная ошибка при старте:", e);
  process.exit(1);
});
