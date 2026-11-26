import { Bot, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import { GoogleGenAI } from "@google/genai";
import pg from "pg";
import dotenv from "dotenv";
import express from "express";
import crypto from "crypto";

dotenv.config();

// ═════════════════════════════ Конфиг ═════════════════════════════
const TZ = "Asia/Almaty";           // для вывода времени
const TZ_OFFSET_H = 5;              // UTC+5 (фиксированный)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
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
const COMPANY_NAME = process.env.COMPANY_NAME || "Oilan Group";   // название организации в сообщениях
const CEO_NAME = process.env.CEO_NAME || "Алишер";                 // как бот обращается к руководителю

// ═════════════════════════════ Хелперы ═════════════════════════════
// Всё время в БД хранится в UTC. Часовой пояс используется только при вводе и выводе.
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const pad2 = (n) => String(n).padStart(2, "0");
const fmt = (d) => new Date(d).toLocaleString("ru-RU", { timeZone: TZ });

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
  };
}

const todayKey = (date = new Date()) => {
  const p = localParts(date);
  return `${p.y}-${pad2(p.mo + 1)}-${pad2(p.d)}`;
};

const STATUS_RU = {
  pending: "ожидает",
  in_progress: "в работе",
  completed: "выполнена",
  cancelled: "отменена",
};

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
  `);

  // Для эскалации: старые просроченные задачи не должны получить «эскалацию» разом после обновления
  const escCol = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'escalated'`
  );
  const firstEscalationRun = escCol.rows.length === 0;

  // Миграция: CREATE TABLE IF NOT EXISTS не добавляет колонки в уже существующую таблицу
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
      ADD COLUMN IF NOT EXISTS recurring_id INTEGER;
  `);

  if (firstEscalationRun) {
    await pool.query(`UPDATE tasks SET escalated = TRUE WHERE deadline < now()`);
  }
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

// «Один раз в день»: возвращает true только первому, кто заявил ключ на этот день (переживает перезапуски)
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
    `SELECT telegram_id, username, first_name FROM employees
     WHERE LOWER(username) = LOWER($1) OR LOWER(first_name) = LOWER($1) LIMIT 1`,
    [name]
  );
  return r.rows[0] || null;
}

// ═════════════════════════════ Gemini ═════════════════════════════
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function gen(contents, { json = false } = {}) {
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents,
    ...(json ? { config: { responseMimeType: "application/json" } } : {}),
  });
  return (response.text || "").trim();
}

function parseJSONLoose(raw) {
  let s = String(raw).trim().replace(/```json/gi, "").replace(/```/g, "").trim();
  const f = s.indexOf("{"), l = s.lastIndexOf("}");
  if (f !== -1 && l !== -1) s = s.slice(f, l + 1);
  return JSON.parse(s);
}

// ═════════════════════════════ Бот ═════════════════════════════
const bot = new Bot(TOKEN);

bot.catch((err) => {
  console.error("Ошибка в хендлере:", err.error?.message || err.message || err);
});

const safeSend = (chatId, text, extra = {}) =>
  bot.api.sendMessage(chatId, text, { ...HTML, ...extra }).catch((e) => {
    console.error(`sendMessage -> ${chatId} failed:`, e.message);
    return null;
  });

function taskBody(t) {
  return `📝 <b>Задача #${t.id}:</b> ${esc(t.task_title)}\n⏰ <b>Срок:</b> ${fmt(t.deadline)}`;
}

function empKeyboard(id, withAccept = true) {
  const kb = new InlineKeyboard();
  if (withAccept) kb.text("🚀 Взял в работу", `emp_accept_${id}`);
  kb.text("✅ Завершить", `emp_complete_${id}`)
    .row()
    .text("⏱ Запросить отсрочку", `emp_extend_${id}`)
    .row()
    .text("🧩 План по шагам", `plan_${id}`);
  return kb;
}

// ─── Меню команд (появляется при вводе «/») ───
async function setCeoCommands() {
  await bot.api.setMyCommands(
    [
      { command: "staff", description: "Сотрудники и постановка задачи" },
      { command: "tasks", description: "Сводка по задачам (с отменой)" },
      { command: "brief", description: "ИИ-брифинг по задачам сейчас" },
      { command: "stats", description: "Статистика сотрудников" },
      { command: "export", description: "Выгрузка задач в Excel" },
      { command: "recurring", description: "Повторяющиеся задачи" },
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
          "• Пишите задачу текстом или голосом. Можно сразу несколько, например «Ержану отчёт до завтра, Айгуль созвониться в пятницу»\n" +
          "• Можно спросить: «Что сейчас горит?», «Что по Ержану?»\n" +
          "• Повторяющиеся: «Каждый понедельник до 10:00 Ержану отчёт по продажам»\n\n" +
          "/staff — сотрудники и задача кнопкой\n" +
          "/tasks — сводка и отмена задач\n" +
          "/brief — ИИ-брифинг\n" +
          "/stats — статистика сотрудников\n" +
          "/export — выгрузка в Excel\n" +
          "/recurring — повторяющиеся задачи",
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

bot.command("staff", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID) return;
  try {
    const r = await pool.query(
      `SELECT telegram_id, username, first_name FROM employees WHERE telegram_id != $1 ORDER BY first_name`,
      [CEO_ID]
    );
    if (r.rows.length === 0) {
      return ctx.reply("📭 Пока никто из сотрудников не нажал /start. Отправьте им ссылку на бота.");
    }
    const kb = new InlineKeyboard();
    r.rows.forEach((e, i) => {
      const label = `${e.first_name || "Без имени"}${e.username ? " (@" + e.username + ")" : ""}`;
      kb.text(label, `pick_${e.telegram_id}`);
      if (i % 2 === 1) kb.row();
    });
    await ctx.reply(
      `👥 <b>Сотрудники в боте (${r.rows.length}):</b>\nНажмите на сотрудника, чтобы поставить ему задачу.`,
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
  await ctx.reply("Ок, действие отменено.");
});

// ─── /tasks (сводка для CEO, с отменой) ───
bot.command("tasks", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID) return;
  try {
    const res = await pool.query(
      `SELECT id, task_title, assignee_username, status, deadline, checklist
       FROM tasks ORDER BY id DESC LIMIT 15`
    );
    if (res.rows.length === 0) return ctx.reply("📭 В базе пока нет задач.");

    const now = Date.now();
    let msg = `📊 <b>Сводка по задачам ${esc(COMPANY_NAME)}:</b>\n\n`;
    const kb = new InlineKeyboard();
    let btnCount = 0;
    for (const t of res.rows) {
      const active = t.status !== "completed" && t.status !== "cancelled";
      const overdue = active && new Date(t.deadline).getTime() < now;
      const icon = overdue ? "🔴" : statusIcon(t);
      msg += `${icon} <b>#${t.id}</b> | ${esc(assigneeLabel(t))}\n`;
      msg += `📝 ${esc(t.task_title)}\n`;
      msg += `📌 Статус: <code>${esc(t.status)}</code> | Срок: ${fmt(t.deadline)}${overdue ? " (просрочено)" : ""}\n`;
      if (Array.isArray(t.checklist) && t.checklist.length) {
        msg += `🧩 План: ${t.checklist.filter((s) => s.done).length}/${t.checklist.length}\n`;
      }
      msg += "\n";
      if (active) {
        kb.text(`🗑 Отменить #${t.id}`, `ceo_cancel_${t.id}`);
        btnCount++;
        if (btnCount % 2 === 0) kb.row();
      }
    }
    if (btnCount > 0) msg += "<i>Кнопки ниже отменяют задачу, сотрудник получит уведомление.</i>";
    await ctx.reply(msg, btnCount > 0 ? { ...HTML, reply_markup: kb } : HTML);
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Не удалось загрузить задачи.");
  }
});

// ─── /my_tasks ───
bot.command("my_tasks", async (ctx) => {
  const telegramId = String(ctx.from.id);
  try {
    const empRes = await pool.query(`SELECT username FROM employees WHERE telegram_id = $1`, [telegramId]);
    if (empRes.rows.length === 0) return ctx.reply("⚠️ Сначала зарегистрируйтесь через /start");

    const username = empRes.rows[0].username;
    const tasksRes = await pool.query(
      `SELECT id, task_title, status, deadline FROM tasks
       WHERE status NOT IN ('completed', 'cancelled')
         AND (assignee_telegram_id = $1 OR ($2::text IS NOT NULL AND LOWER(assignee_username) = LOWER($2)))
       ORDER BY id DESC`,
      [telegramId, username]
    );
    if (tasksRes.rows.length === 0) return ctx.reply("📭 У вас нет активных задач. Отличная работа!");

    let msg = "📋 <b>Ваши текущие задачи:</b>\n\n";
    for (const t of tasksRes.rows) {
      msg += `📌 <b>Задача #${t.id}</b>\n📝 ${esc(t.task_title)}\n⏰ Срок: ${fmt(t.deadline)}\n\n`;
    }
    await ctx.reply(msg, HTML);
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Ошибка при загрузке задач.");
  }
});

// ═════════════════════════════ Разбор сообщений CEO ═════════════════════════════
// Приводим даты вида 15:11:2026, 15/11/2026, 15-11-2026, «15 11 2026» к 15.11.2026
function normalizeDates(s) {
  return s
    .replace(/\b(\d{1,2})[:\/-](\d{1,2})[:\/-](\d{4})\b/g, "$1.$2.$3")
    .replace(/\b(\d{1,2})\s+(\d{1,2})\s+(20\d{2})\b/g, "$1.$2.$3");
}

// Запасной парсер дедлайна, если Gemini недоступен или не вернул срок
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
  // Задачи создаются в 08:00, поэтому срок не раньше 08:30
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

async function parseCEOMessage(rawText) {
  const text = normalizeDates(rawText);
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
    console.error("staff list for Gemini:", e.message);
  }

  let intent = "tasks";
  let items = null; // null = Gemini не сработал

  try {
    const raw = await gen(
      `Сейчас ${nowLocalIso} (${weekday}), часовой пояс UTC+5 (Астана).
Список сотрудников: ${staffList || "пусто"}.
Сообщение руководителя: """${text}"""

Определи намерение руководителя и верни JSON строго такого вида:
{"intent": "tasks" | "question" | "other",
 "tasks": [{"title": "...", "user": "...", "deadline_iso": "...", "recurrence": null}]}

Правила:
- intent="tasks": руководитель ставит одно или несколько поручений. Каждое отдельное поручение — отдельный элемент в tasks (например, «Ержану отчёт до завтра, Айгуль созвониться с клиентом» — это 2 задачи).
- intent="question": руководитель спрашивает о задачах, сроках, просрочках, сотрудниках или статусе (на это нужно ответить, а не создавать задачу). Тогда tasks = [].
- intent="other": приветствие, благодарность и прочее без задачи и вопроса. Тогда tasks = [].
- title: краткая суть задачи без имени исполнителя и срока.
- user: если исполнитель совпал с кем-то из списка сотрудников (учти падежи: Ержану, Ержана) — его username без @, а если у него нет username — его имя из списка; если в списке нет — имя из текста; иначе null.
- deadline_iso: срок в формате ISO 8601 с оффсетом +05:00 или null, если не указан. Относительные сроки («завтра», «в пятницу», «через 3 часа») считай от текущего времени.
- recurrence: только если поручение повторяющееся («каждый понедельник», «ежедневно», «по будням», «каждого 5 числа»), иначе null. Формат: {"freq": "daily" | "weekdays" | "weekly" | "monthly", "weekday": число 1-7 (1=понедельник) для weekly, "day_of_month": число 1-31 для monthly, "time": "HH:MM" — время дедлайна в этот день или null}. Для повторяющихся задач deadline_iso = null.`,
      { json: true }
    );
    const parsed = parseJSONLoose(raw);
    intent = ["tasks", "question", "other"].includes(parsed.intent) ? parsed.intent : "tasks";
    items = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
      .slice(0, 10)
      .map((t) => ({
        title: String(t?.title || "").trim(),
        user: t?.user && String(t.user).toLowerCase() !== "null" ? String(t.user).replace("@", "").trim() : null,
        deadline: t?.deadline_iso && !isNaN(Date.parse(t.deadline_iso)) ? new Date(t.deadline_iso) : null,
        recurrence: validRecurrence(t?.recurrence),
      }))
      .filter((t) => t.title);
  } catch (err) {
    console.error("Gemini parse error:", err.message);
  }

  const mu = text.match(/@([a-zA-Z0-9_]+)/);
  const fallbackItem = () => ({
    title: text,
    user: mu ? mu[1] : null,
    deadline: fallbackDeadline(text, now),
    recurrence: null,
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

  return { intent, items, text, fallbackItem };
}

// ═════════════════════════════ Создание задач ═════════════════════════════
async function notifyEmployeeNewTask(task, empId) {
  if (!empId) return null;
  return safeSend(empId, `📬 <b>Вам назначена новая задача!</b>\n\n${taskBody(task)}`, {
    reply_markup: empKeyboard(task.id, true),
  });
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
    // Если срок на сегодня уже прошёл — первый запуск не сегодня
    const lastRun = dueToday <= new Date() ? todayKey() : null;
    const r = await pool.query(
      `INSERT INTO recurring_tasks
         (title, assignee_username, assignee_telegram_id, freq, weekday, day_of_month, due_time, last_run_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [item.title, assigneeName, emp?.telegram_id || null, rec.freq, rec.weekday, rec.day_of_month, rec.time, lastRun]
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
    `INSERT INTO tasks (task_title, assignee_username, assignee_telegram_id, creator_telegram_id, deadline, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
    [item.title, assigneeName, emp?.telegram_id || null, CEO_ID, deadline.toISOString()]
  );
  const task = ins.rows[0];
  const sent = emp ? await notifyEmployeeNewTask(task, emp.telegram_id) : null;
  return { kind: "task", task, emp, notes, sent: !!sent, user: item.user };
}

function empStateLine(r) {
  if (r.emp) {
    return r.sent
      ? "✅ <i>Уведомление отправлено сотруднику в ЛС.</i>"
      : "⚠️ <i>Не удалось отправить сообщение сотруднику (возможно, он заблокировал бота).</i>";
  }
  if (r.user) {
    return `⚠️ <i>Сотрудник «${esc(r.user)}» ещё не нажал /start у бота. Как только нажмёт — задача привяжется к нему.</i>`;
  }
  return "⚠️ <i>Исполнитель не определён.</i>";
}

async function processTaskCreation(ctx, textSource, forcedEmp = null) {
  const statusMsg = await ctx.reply("🧠 ИИ анализирует сообщение...");
  const cleanup = () => ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
  try {
    const parsed = await parseCEOMessage(textSource);
    let { intent, items } = parsed;

    // Вопрос к боту (не при выборе сотрудника кнопкой)
    if (!forcedEmp && intent === "question") {
      await cleanup();
      return answerQuestion(ctx, textSource);
    }
    if (!forcedEmp && (intent === "other" || items.length === 0)) {
      await cleanup();
      return ctx.reply(
        "🤔 Не вижу в сообщении задачи или вопроса. Опишите поручение (кому, что, к какому сроку) или спросите про статус задач."
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
        `⏰ <b>Дедлайн:</b> ${fmt(task.deadline)}\n`;
      if (r.notes.length) reply += `\nℹ️ ${esc(r.notes.join("; "))}\n`;
      reply += `\n${empStateLine(r)}`;
      return ctx.reply(reply, {
        ...HTML,
        reply_markup: new InlineKeyboard()
          .text("🗑 Отменить задачу", `ceo_cancel_${task.id}`)
          .text("🧩 Разбить на шаги", `plan_${task.id}`),
      });
    }

    // ── Несколько задач ──
    let msg = `📌 <b>Создано: ${results.filter((r) => r.kind !== "error").length} из ${results.length}</b>\n\n`;
    const kb = new InlineKeyboard();
    let n = 0;
    results.forEach((r, i) => {
      if (r.kind === "task") {
        const t = r.task;
        msg += `${i + 1}. <b>#${t.id}</b> ${esc(assigneeLabel(t))} — ${esc(t.task_title)}\n`;
        msg += `   ⏰ ${fmt(t.deadline)} ${r.emp ? (r.sent ? "✅" : "⚠️ не доставлено") : "⚠️ нет /start"}`;
        if (r.notes.length) msg += ` · <i>${esc(r.notes.join("; "))}</i>`;
        msg += "\n";
        kb.text(`🗑 #${t.id}`, `ceo_cancel_${t.id}`);
      } else if (r.kind === "recurring") {
        msg += `${i + 1}. 🔁 <b>R${r.rec.id}</b> ${esc(assigneeLabel(r.rec))} — ${esc(r.rec.title)}\n`;
        msg += `   📅 ${esc(describeRule(r.rec))}, до ${r.rec.due_time}\n`;
        kb.text(`🗑 повтор R${r.rec.id}`, `rec_del_${r.rec.id}`);
      } else {
        msg += `${i + 1}. ❌ Не удалось создать: ${esc(r.title)}\n`;
        return;
      }
      n++;
      if (n % 2 === 0) kb.row();
    });
    await ctx.reply(msg, { ...HTML, reply_markup: kb });
  } catch (err) {
    console.error("processTaskCreation error:", err);
    await ctx.api
      .editMessageText(ctx.chat.id, statusMsg.message_id, "❌ Не удалось обработать сообщение. Попробуйте ещё раз.")
      .catch(() => {});
  }
}

// ═════════════════════════════ Вопросы боту ═════════════════════════════
async function answerQuestion(ctx, question) {
  const wait = await ctx.reply("🔎 Смотрю данные...");
  try {
    const rows = await pool.query(
      `SELECT t.id, t.task_title, t.assignee_username, t.status, t.deadline, t.created_at, t.completed_at,
              t.report_text, t.ai_review, e.first_name
       FROM tasks t ${TASK_EMP_JOIN}
       WHERE t.created_at >= now() - interval '90 days' OR t.status NOT IN ('completed', 'cancelled')
       ORDER BY t.id DESC LIMIT 200`
    );
    const lines = rows.rows.map(
      (t) =>
        `#${t.id} | ${t.first_name || assigneeLabel(t)} | ${STATUS_RU[t.status] || t.status} | срок ${fmt(t.deadline)} | создана ${fmt(t.created_at)}` +
        (t.completed_at ? ` | закрыта ${fmt(t.completed_at)}` : "") +
        ` | ${t.task_title}` +
        (t.report_text ? ` | отчёт: ${String(t.report_text).slice(0, 120)}` : "") +
        (t.ai_review ? ` | оценка ИИ: ${t.ai_review}` : "")
    );
    const emps = await pool.query(`SELECT first_name, username FROM employees WHERE telegram_id != $1`, [CEO_ID]);
    const staff = emps.rows.map((e) => `${e.first_name || ""}${e.username ? " (@" + e.username + ")" : ""}`.trim()).join("; ");

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
      .editMessageText(ctx.chat.id, wait.message_id, "❌ Не получилось ответить на вопрос (ИИ недоступен). Попробуйте позже или откройте /tasks.")
      .catch(() => {});
  }
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
    pool.query(`SELECT id, task_title, assignee_username, deadline FROM tasks WHERE ${ACTIVE} AND deadline < $1 ORDER BY deadline LIMIT 8`, [now]),
    pool.query(`SELECT id, task_title, assignee_username, deadline FROM tasks WHERE ${ACTIVE} AND deadline >= $1 AND deadline < $2 ORDER BY deadline LIMIT 10`, [now, tomorrowStart]),
    pool.query(`SELECT id, task_title, assignee_username, deadline FROM tasks WHERE ${ACTIVE} AND deadline >= $1 AND deadline < $2 ORDER BY deadline LIMIT 10`, [tomorrowStart, afterTomorrow]),
    pool.query(`SELECT id, task_title, assignee_username FROM tasks WHERE status = 'completed' AND completed_at >= $1 ORDER BY completed_at DESC LIMIT 10`, [todayStart]),
    pool.query(`SELECT id, task_title, assignee_username, ai_review FROM tasks WHERE status = 'completed' AND completed_at >= $1 AND ai_review LIKE 'incomplete%' LIMIT 5`, [todayStart]),
  ]);

  const c = counts.rows[0];
  const lite = (r) => ({ id: r.id, task: r.task_title, who: assigneeLabel(r), deadline: r.deadline ? fmt(r.deadline) : undefined, review: r.ai_review || undefined });
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

Требования: по-русски, 5–9 строк, по делу, без markdown-разметки (без ** и #), можно эмодзи и маркеры «•». Называй исполнителей и номера задач (#N). Выдели то, что требует внимания руководителя. В конце — одна короткая рекомендация. Не выдумывай данных.`
    );
    if (text) return text;
  } catch (e) {
    console.error("brief Gemini error:", e.message);
  }

  // Запасной вариант без ИИ
  let t = `📊 Активных задач: ${data.active}, просрочено: ${data.overdue_total}. Закрыто сегодня: ${data.done_today}, создано сегодня: ${data.created_today}.`;
  if (data.overdue.length) t += "\n🔴 Просрочены:\n" + data.overdue.map((x) => `• #${x.id} ${x.who} — ${x.task}`).join("\n");
  if (data.due_today.length) t += "\n⏰ Сегодня к сроку:\n" + data.due_today.map((x) => `• #${x.id} ${x.who} — ${x.task} (${x.deadline})`).join("\n");
  return t;
}

async function sendBrief(kind) {
  const text = await generateBrief(kind);
  const title = kind === "morning" ? "🌅 <b>Утренний брифинг</b>" : kind === "evening" ? "🌆 <b>Вечерние итоги</b>" : "📊 <b>Брифинг</b>";
  await safeSend(CEO_ID, `${title}\n\n${esc(text).slice(0, 3800)}`);
}

bot.command("brief", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID) return;
  const wait = await ctx.reply("🧠 Готовлю брифинг...");
  try {
    const text = await generateBrief("manual");
    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    await ctx.reply(`📊 <b>Брифинг</b>\n\n${esc(text).slice(0, 3800)}`, HTML);
  } catch (e) {
    console.error("brief error:", e);
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, "❌ Не удалось подготовить брифинг.").catch(() => {});
  }
});

// ═════════════════════════════ Статистика и выгрузка ═════════════════════════════
function parseDaysArg(ctx, def = 30) {
  const n = parseInt(String(ctx.match || "").trim(), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 365) : def;
}

bot.command("stats", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID) return;
  const days = parseDaysArg(ctx);
  try {
    const r = await pool.query(
      `SELECT LOWER(COALESCE(NULLIF(t.assignee_username, ''), 'не назначен')) AS who,
         COUNT(*) FILTER (WHERE t.status <> 'cancelled') AS total,
         COUNT(*) FILTER (WHERE t.status = 'completed') AS done,
         COUNT(*) FILTER (WHERE t.status = 'completed' AND t.completed_at IS NOT NULL AND t.completed_at <= t.deadline) AS ontime,
         COUNT(*) FILTER (WHERE t.status = 'completed' AND t.completed_at IS NOT NULL) AS done_timed,
         COUNT(*) FILTER (WHERE t.status NOT IN ('completed', 'cancelled') AND t.deadline < now()) AS overdue,
         COUNT(*) FILTER (WHERE t.status = 'cancelled') AS cancelled,
         AVG(EXTRACT(EPOCH FROM (t.completed_at - t.created_at)))
           FILTER (WHERE t.status = 'completed' AND t.completed_at IS NOT NULL AND t.created_at IS NOT NULL) AS avg_sec
       FROM tasks t
       WHERE t.created_at >= now() - make_interval(days => $1::int)
       GROUP BY 1 ORDER BY done DESC, total DESC`,
      [days]
    );
    if (r.rows.length === 0) return ctx.reply(`📭 За последние ${days} дн. задач нет.`);

    let msg = `📈 <b>Статистика за ${days} дн.</b>\n\n`;
    let tTotal = 0, tDone = 0, tOntime = 0, tTimed = 0, tOverdue = 0;
    for (const x of r.rows) {
      tTotal += Number(x.total); tDone += Number(x.done); tOntime += Number(x.ontime);
      tTimed += Number(x.done_timed); tOverdue += Number(x.overdue);
      msg += `👤 <b>${esc(assigneeLabel({ assignee_username: x.who }))}</b>\n`;
      msg += `   Выполнено: ${x.done} из ${x.total} (${pct(x.done, x.total)})\n`;
      msg += `   В срок: ${x.ontime} из ${x.done_timed} (${pct(x.ontime, x.done_timed)})\n`;
      msg += `   Просрочено сейчас: ${x.overdue}${Number(x.cancelled) ? ` · отменено: ${x.cancelled}` : ""}\n`;
      msg += `   Среднее время закрытия: ${fmtDuration(x.avg_sec)}\n\n`;
    }
    msg += `<b>Итого:</b> выполнено ${tDone} из ${tTotal} (${pct(tDone, tTotal)}), в срок ${pct(tOntime, tTimed)}, просрочено сейчас ${tOverdue}.\n`;
    msg += `<i>Период можно менять: /stats 7, /stats 90</i>`;
    await ctx.reply(msg.slice(0, 4000), HTML);
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Не удалось собрать статистику.");
  }
});

bot.command("export", async (ctx) => {
  if (String(ctx.from.id) !== CEO_ID) return;
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

    const header = ["№", "Задача", "Исполнитель", "Статус", "Создана", "Срок", "Закрыта", "В срок", "Отчёт", "Оценка ИИ"];
    const data = r.rows.map((t) => [
      t.id,
      t.task_title,
      t.first_name || assigneeLabel(t),
      STATUS_RU[t.status] || t.status,
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
      const widths = [6, 45, 24, 14, 20, 20, 20, 9, 50, 40];
      ws.columns = header.map((h, i) => ({ header: h, key: `c${i}`, width: widths[i] }));
      data.forEach((row) => ws.addRow(row));
      ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
      ws.autoFilter = { from: "A1", to: "J1" };
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
      // Запасной вариант: CSV (Excel открывает его без проблем, разделитель «;»)
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
  if (String(ctx.from.id) !== CEO_ID) return;
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
  const isoWd = ((new Date(Date.UTC(p.y, p.mo, p.d)).getUTCDay() + 6) % 7) + 1;
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
      `INSERT INTO tasks (task_title, assignee_username, assignee_telegram_id, creator_telegram_id, deadline, status, recurring_id)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING *`,
      [r.title, r.assignee_username, empId, CEO_ID, deadline.toISOString(), r.id]
    );
    const task = ins.rows[0];
    const sent = empId ? await notifyEmployeeNewTask(task, empId) : null;
    await safeSend(
      CEO_ID,
      `🔁 <b>Создана повторяющаяся задача #${task.id}</b>\n👤 ${esc(assigneeLabel(task))}\n📝 ${esc(task.task_title)}\n⏰ ${fmt(task.deadline)}\n` +
        (sent ? "✅ Сотрудник уведомлён." : "⚠️ Сотрудник не получил уведомление (нет /start).")
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

async function finalizeReport(ctx, userId, task, reportText) {
  await clearState(userId);
  await pool.query(
    `UPDATE tasks SET status = 'completed', report_text = $1, completed_at = now() WHERE id = $2`,
    [reportText, task.id]
  );
  await ctx.reply(`🎉 Задача #${task.id} успешно закрыта с отчётом!`);

  const filesRes = await pool.query(`SELECT * FROM task_files WHERE task_id = $1 AND sent IS NOT TRUE ORDER BY id`, [task.id]);

  let reviewLine = "";
  try {
    const rv = await reviewReport(task, reportText, filesRes.rows.length);
    await pool.query(`UPDATE tasks SET ai_review = $1 WHERE id = $2`, [`${rv.verdict}: ${rv.comment}`, task.id]);
    const icon = rv.verdict === "complete" ? "✅" : rv.verdict === "incomplete" ? "⚠️" : "❔";
    const label = rv.verdict === "complete" ? "отчёт закрывает задачу" : rv.verdict === "incomplete" ? "отчёт неполный" : "сложно оценить";
    reviewLine = `\n\n${icon} <b>Оценка ИИ:</b> ${label}${rv.comment ? ` — ${esc(rv.comment)}` : ""}`;
  } catch (e) {
    console.error("AI review:", e.message);
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
}

// Файлы и фото от сотрудника в режиме «пишет отчёт»
async function handleAttachment(ctx, fileId, type) {
  const userId = String(ctx.from.id);
  if (userId === CEO_ID) return;
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

bot.on("message:photo", (ctx) => handleAttachment(ctx, ctx.message.photo.at(-1).file_id, "photo"));
bot.on("message:document", (ctx) => handleAttachment(ctx, ctx.message.document.file_id, "document"));
bot.on("message:video", (ctx) => handleAttachment(ctx, ctx.message.video.file_id, "video"));

// ═════════════════════════════ Текстовые сообщения ═════════════════════════════
bot.on("message:text", async (ctx) => {
  const userId = String(ctx.from.id);
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  // 1. Ждём отчёт или причину отсрочки от сотрудника?
  const state = await getState(userId);
  if (state) {
    const task = await getTask(state.task_id);
    await clearState(userId);

    if (!task) return ctx.reply("⚠️ Задача не найдена.");
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

  // 3. Сообщение CEO: задача(и) / повтор / вопрос
  const assign = getCeoAssign(userId);
  if (assign) ceoAssign.delete(userId);
  await processTaskCreation(ctx, text, assign?.emp || null);
});

// ═════════════════════════════ Голосовые ═════════════════════════════
async function transcribeVoice(ctx) {
  const file = await ctx.getFile();
  const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const audioRes = await fetch(fileUrl);
  if (!audioRes.ok) throw new Error(`Telegram file HTTP ${audioRes.status}`);
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
  return gen([
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "audio/ogg", data: audioBuffer.toString("base64") } },
        {
          text:
            "Дословно расшифруй это голосовое сообщение. Верни только текст сказанного, " +
            "без комментариев. Сохрани имена, @username, даты и время как были произнесены.",
        },
      ],
    },
  ]);
}

bot.on("message:voice", async (ctx) => {
  const userId = String(ctx.from.id);

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
      const transcript = await transcribeVoice(ctx);
      await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
      if (!transcript) return ctx.reply("❌ Не удалось распознать речь. Напишите отчёт текстом.");
      return finalizeReport(ctx, userId, task, `🎙 (голосовой отчёт) ${transcript}`);
    } catch (err) {
      console.error("Employee voice error:", err);
      return ctx.api.editMessageText(ctx.chat.id, wait.message_id, "❌ Не удалось обработать голосовое. Напишите отчёт текстом.").catch(() => {});
    }
  }

  // CEO
  const msg = await ctx.reply("🎙 Скачиваю и расшифровываю голосовое...");
  try {
    const transcribed = await transcribeVoice(ctx);
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    if (!transcribed) return ctx.reply("❌ Не удалось распознать речь. Попробуйте ещё раз.");

    await ctx.reply(`🎙 <b>Распознано:</b> «${esc(transcribed)}»`, HTML);
    const assign = getCeoAssign(CEO_ID);
    if (assign) ceoAssign.delete(CEO_ID);
    await processTaskCreation(ctx, transcribed, assign?.emp || null);
  } catch (err) {
    console.error("Voice processing error:", err);
    await ctx.api
      .editMessageText(ctx.chat.id, msg.message_id, "❌ Не удалось обработать голосовое сообщение.")
      .catch(() => {});
  }
});

// ═════════════════════════════ Кнопки ═════════════════════════════
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = String(ctx.from.id);
  const isCeo = userId === CEO_ID;
  const alertNo = (text) => ctx.answerCallbackQuery({ text, show_alert: true });

  // ─── Выбор сотрудника из /staff ───
  const pick = data.match(/^pick_(\d+)$/);
  if (pick) {
    if (!isCeo) return alertNo("Нет прав");
    const r = await pool.query(`SELECT telegram_id, username, first_name FROM employees WHERE telegram_id = $1`, [pick[1]]);
    if (!r.rows[0]) return alertNo("Сотрудник не найден");
    const emp = r.rows[0];
    ceoAssign.set(CEO_ID, { emp, ts: Date.now() });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✍️ Задача для <b>${esc(emp.first_name || emp.username)}</b>.\n` +
        `Напишите текст или отправьте голосовое. Срок укажите в сообщении, например «до завтра 15:00». Отмена: /cancel`,
      HTML
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
    await ctx.reply(`🗑 Повторяющаяся задача R${recDel[1]} удалена: «${esc(r.rows[0].title)}». Уже созданные задачи остались.`, HTML);
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
    if (task.status === "completed" || task.status === "cancelled") return alertNo("Задача уже закрыта");

    await ctx.answerCallbackQuery("🧩 Готовлю план...");
    let steps = Array.isArray(task.checklist) && task.checklist.length ? task.checklist : null;
    if (!steps) {
      try {
        steps = await generatePlan(task);
      } catch (e) {
        console.error("generatePlan:", e.message);
        return ctx.reply("❌ Не удалось составить план (ИИ недоступен). Попробуйте позже.");
      }
      await pool.query(`UPDATE tasks SET checklist = $1::jsonb WHERE id = $2`, [JSON.stringify(steps), id]);
      task.checklist = steps;
    }
    const target = isCeo ? (await resolveAssigneeId(task)) || CEO_ID : userId;
    const { text, kb } = renderChecklist(task);
    await safeSend(target, text, { reply_markup: kb });
    if (isCeo && target !== CEO_ID) await ctx.reply(`🧩 План по задаче #${id} отправлен сотруднику.`);
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
    if (task.status === "completed" || task.status === "cancelled") {
      return alertNo(task.status === "completed" ? "Задача уже выполнена" : "Задача уже отменена");
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `❓ <b>Отменить задачу #${id}?</b>\n📝 ${esc(task.task_title)}\n👤 ${esc(assigneeLabel(task))}\n⏰ ${fmt(task.deadline)}`,
      {
        ...HTML,
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
    const upd = await pool.query(
      `UPDATE tasks SET status = 'cancelled', extension_requested = FALSE
       WHERE id = $1 AND status NOT IN ('completed', 'cancelled') RETURNING id`,
      [id]
    );
    if (upd.rows.length === 0) {
      await ctx.answerCallbackQuery({ text: "Задачу уже нельзя отменить", show_alert: true });
      await ctx.editMessageText(`ℹ️ Задача #${id} уже выполнена или отменена.`).catch(() => {});
      return;
    }
    await pool.query(`DELETE FROM user_states WHERE task_id = $1`, [id]);
    await ctx.answerCallbackQuery("Задача отменена");
    await ctx.editMessageText(`🚫 <b>Задача #${id} отменена.</b>\n📝 ${esc(task.task_title)}`, HTML).catch(() => {});
    const empId = await resolveAssigneeId(task);
    if (empId) {
      await safeSend(empId, `🚫 <b>Задача #${id} отменена руководителем.</b>\n📝 ${esc(task.task_title)}\nДелать её больше не нужно.`);
    }
    return;
  }

  // ─── Вернуть выполненную задачу на доработку ───
  if (action === "ceo_reopen") {
    if (task.status !== "completed") return alertNo("Задача не в статусе «выполнена»");
    await pool.query(`UPDATE tasks SET status = 'in_progress', completed_at = NULL, ai_review = NULL WHERE id = $1`, [id]);
    await ctx.answerCallbackQuery("Возвращено на доработку");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    await ctx.reply(`↩️ Задача #${id} возвращена сотруднику на доработку.`);
    const empId = await resolveAssigneeId(task);
    if (empId) {
      await safeSend(empId, `↩️ <b>Руководитель вернул задачу #${id} на доработку.</b>\n\n${taskBody(task)}`, {
        reply_markup: empKeyboard(id, false),
      });
    }
    return;
  }

  // ─── Руководитель сам продлевает срок (из эскалации) ───
  if (action === "ceo_extend") {
    if (task.status === "completed" || task.status === "cancelled") return alertNo("Задача уже закрыта");
    const upd = await pool.query(
      `UPDATE tasks SET deadline = GREATEST(deadline, now()) + INTERVAL '24 hours',
         extension_requested = FALSE, notified_expired = FALSE, reminder_sent = FALSE, escalated = FALSE
       WHERE id = $1 RETURNING deadline`,
      [id]
    );
    await ctx.answerCallbackQuery("Срок продлён на 24 часа");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    await ctx.reply(`⏱ Срок задачи #${id} продлён до ${fmt(upd.rows[0].deadline)}.`);
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
         extension_requested = FALSE, notified_expired = FALSE, reminder_sent = FALSE, escalated = FALSE
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
    `SELECT e.telegram_id, t.id, t.task_title, t.deadline
     FROM tasks t ${TASK_EMP_JOIN}
     WHERE t.status NOT IN ('completed', 'cancelled') AND e.telegram_id IS NOT NULL
     ORDER BY e.telegram_id, t.deadline`
  );
  const byEmp = new Map();
  for (const r of rows.rows) {
    if (!byEmp.has(r.telegram_id)) byEmp.set(r.telegram_id, []);
    byEmp.get(r.telegram_id).push(r);
  }
  for (const [tgId, tasks] of byEmp) {
    let msg = "🌅 <b>Доброе утро! Ваш план задач:</b>\n\n";
    for (const t of tasks) msg += `• <b>#${t.id}</b>: ${esc(t.task_title)} (срок: ${fmt(t.deadline)})\n`;
    await safeSend(tgId, msg);
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

    // 1. Напоминание за 15 минут
    const upcoming = await pool.query(
      `SELECT t.id, t.task_title, e.telegram_id
       FROM tasks t ${TASK_EMP_JOIN}
       WHERE t.deadline <= $1 AND t.deadline > $2 AND ${ACTIVE} AND t.reminder_sent IS NOT TRUE`,
      [in15, nowISO]
    );
    for (const t of upcoming.rows) {
      if (t.telegram_id) {
        await safeSend(
          t.telegram_id,
          `⚠️ <b>Напоминание:</b> до дедлайна по задаче #${t.id} осталось менее 15 минут!\n\n📝 ${esc(t.task_title)}`
        );
      }
      await pool.query(`UPDATE tasks SET reminder_sent = TRUE WHERE id = $1`, [t.id]);
    }

    // 2. Просрочка
    const expired = await pool.query(
      `SELECT t.id, t.task_title, t.assignee_username, e.telegram_id
       FROM tasks t ${TASK_EMP_JOIN}
       WHERE t.deadline <= $1 AND ${ACTIVE} AND t.notified_expired IS NOT TRUE`,
      [nowISO]
    );
    for (const t of expired.rows) {
      if (t.telegram_id) {
        await safeSend(t.telegram_id, `⏰ <b>ВНИМАНИЕ! Дедлайн по задаче #${t.id} истёк!</b>\n\n📝 ${esc(t.task_title)}`);
      }
      await safeSend(CEO_ID, `⚠️ <b>Просрочка: ${esc(assigneeLabel(t))}, задача #${t.id}</b>\n📝 ${esc(t.task_title)}`);
      await pool.query(`UPDATE tasks SET notified_expired = TRUE WHERE id = $1`, [t.id]);
    }

    // 3. Эскалация: просрочка дольше ESCALATION_HOURS часов
    const cutoff = new Date(now.getTime() - ESCALATION_HOURS * 3600000).toISOString();
    const escalate = await pool.query(
      `SELECT t.id, t.task_title, t.assignee_username, t.deadline, e.telegram_id
       FROM tasks t ${TASK_EMP_JOIN}
       WHERE t.deadline <= $1 AND ${ACTIVE} AND t.escalated IS NOT TRUE AND t.extension_requested IS NOT TRUE`,
      [cutoff]
    );
    for (const t of escalate.rows) {
      if (t.telegram_id) {
        await safeSend(
          t.telegram_id,
          `🔥 <b>Задача #${t.id} просрочена более ${ESCALATION_HOURS} ч!</b>\n📝 ${esc(t.task_title)}\nСрок был: ${fmt(t.deadline)}\nЗакройте её или запросите отсрочку.`,
          { reply_markup: empKeyboard(t.id, false) }
        );
      }
      await safeSend(
        CEO_ID,
        `🔥 <b>Эскалация:</b> ${esc(assigneeLabel(t))} не закрыл(а) задачу #${t.id} уже более ${ESCALATION_HOURS} ч после срока.\n📝 ${esc(t.task_title)}\nСрок был: ${fmt(t.deadline)}`,
        {
          reply_markup: new InlineKeyboard()
            .text("⏱ +1 день", `ceo_extend_${t.id}`)
            .text("🗑 Отменить", `ceo_cancel_${t.id}`),
        }
      );
      await pool.query(`UPDATE tasks SET escalated = TRUE WHERE id = $1`, [t.id]);
    }

    // 4. Повторяющиеся задачи
    await spawnRecurring(now);

    // 5. Утренний дайджест и брифинги (один раз в день, переживает перезапуски)
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
  await setCommands().catch((e) => console.error("setCommands:", e.message));

  const app = express();
  app.use(express.json());
  app.get("/", (req, res) => res.send(`🤖 ${COMPANY_NAME} bot is running!`));

  if (BOT_MODE === "webhook") {
    const path = `/tg/${WEBHOOK_SECRET}`;
    app.post(path, webhookCallback(bot, "express", { secretToken: WEBHOOK_SECRET }));
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
  console.log("🤖 Ultimate Oilan Group Bot успешно запущен!");
}

main().catch((e) => {
  console.error("Фатальная ошибка при старте:", e);
  process.exit(1);
});
