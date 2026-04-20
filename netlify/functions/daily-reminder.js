// netlify/functions/daily-reminder.js
// Scheduled: every day at 00:00 UTC = 07:00 WIB
// Reads data from Netlify Blob → checks deadlines & events → sends WA

import { getStore } from "@netlify/blobs";

// ─── CONFIG ────────────────────────────────────────────────
const DEFAULT_THRESHOLDS = [30, 14, 7, 3, 1, 0];

// ─── HELPERS ───────────────────────────────────────────────
function getTodayLocal() {
  // Returns YYYY-MM-DD in WIB (UTC+7)
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const y = wib.getUTCFullYear();
  const m = String(wib.getUTCMonth() + 1).padStart(2, '0');
  const d = String(wib.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDays(dateStr) {
  const today = getTodayLocal();
  const [ty, tm, td] = today.split('-').map(Number);
  const [ey, em, ed] = dateStr.split('-').map(Number);
  const t = Date.UTC(ty, tm - 1, td);
  const e = Date.UTC(ey, em - 1, ed);
  return Math.round((e - t) / 86400000);
}

function getEvNextDate(ev) {
  if (!ev.yearly) return ev.date;
  const today = getTodayLocal();
  const [ty, tm, td] = today.split('-').map(Number);
  const [, em, ed] = ev.date.split('-').map(Number);

  let nextYear = ty;
  // Check if this year's occurrence has passed
  const thisOccurrence = Date.UTC(ty, em - 1, ed);
  const todayUTC = Date.UTC(ty, tm - 1, td);
  if (thisOccurrence < todayUTC) nextYear = ty + 1;

  const y = nextYear;
  const m = String(em).padStart(2, '0');
  const d = String(ed).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getEvDays(ev) {
  const nextDate = getEvNextDate(ev);
  return getDays(nextDate);
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];
  return `${d} ${months[m-1]} ${y}`;
}

function getH7Session() {
  // Current WIB hour
  const now = new Date();
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const h = wib.getUTCHours();
  if (h >= 6  && h < 11) return 'morning';
  if (h >= 12 && h < 14) return 'afternoon';
  if (h >= 17 && h < 20) return 'evening';
  return 'morning'; // scheduled at 07:00 WIB → always morning
}

// ─── WA SEND ───────────────────────────────────────────────
async function sendWAToOne(recipient, msg, waConfig) {
  if (!recipient.active || !recipient.phone) return false;
  try {
    if (waConfig.provider === 'fonnte') {
      const r = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: {
          'Authorization': waConfig.token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ target: recipient.phone, message: msg })
      });
      const data = await r.json();
      console.log(`Fonnte → ${recipient.label} (${recipient.phone}):`, data.status);
      return data.status === true || data.status === 'true';
    } else {
      // CallMeBot
      const url = `https://api.callmebot.com/whatsapp.php?phone=${recipient.phone}&text=${encodeURIComponent(msg)}&apikey=${waConfig.apikey}`;
      const r = await fetch(url);
      console.log(`CallMeBot → ${recipient.label} (${recipient.phone}): ${r.status}`);
      return r.ok;
    }
  } catch (err) {
    console.error(`WA send error for ${recipient.label}:`, err.message);
    return false;
  }
}

async function sendWAToAll(msg, waConfig) {
  const recipients = (waConfig.recipients || []).filter(r => r.active && r.phone);
  if (recipients.length === 0) {
    console.log('No active recipients');
    return false;
  }
  const results = await Promise.all(recipients.map(r => sendWAToOne(r, msg, waConfig)));
  return results.some(Boolean);
}

// ─── MAIN HANDLER ──────────────────────────────────────────
export default async (req) => {
  const today = getTodayLocal();
  console.log(`[daily-reminder] Running for ${today} WIB`);

  // Load data from Netlify Blob
  const store = getStore({ name: 'pajaksim', consistency: 'strong' });

  let entries = [], events = [], waConfig = null, settings = {};
  try {
    const eRaw  = await store.get('entries',  { type: 'text' });
    const evRaw = await store.get('events',   { type: 'text' });
    const wRaw  = await store.get('waConfig', { type: 'text' });
    const sRaw  = await store.get('settings', { type: 'text' });

    entries  = eRaw  ? JSON.parse(eRaw)  : [];
    events   = evRaw ? JSON.parse(evRaw) : [];
    waConfig = wRaw  ? JSON.parse(wRaw)  : null;
    settings = sRaw  ? JSON.parse(sRaw)  : {};
  } catch (err) {
    console.error('Failed to load data from blob:', err.message);
    return new Response('Data load failed', { status: 500 });
  }

  if (!waConfig || !waConfig.active) {
    console.log('WA not configured or inactive, skipping');
    return new Response('WA not configured', { status: 200 });
  }

  const thresholds = settings.waThresholds || DEFAULT_THRESHOLDS;
  const session = getH7Session();

  // Track sent notifications (load from blob)
  let sentLog = {};
  try {
    const logRaw = await store.get('sent-log', { type: 'text' });
    sentLog = logRaw ? JSON.parse(logRaw) : {};
  } catch (_) { sentLog = {}; }

  // Prune old log entries (keep only today's)
  Object.keys(sentLog).forEach(k => {
    if (!k.includes(today)) delete sentLog[k];
  });

  let deadlineMsgs = [];
  let h7Msgs       = [];
  let eventMsgs    = [];

  // ── CHECK DEADLINES ────────────────────────────────────
  for (const e of entries) {
    if (e.done) continue;

    const days = getDays(e.tgl);
    const typeName = e.type === 'pajak' ? '🚙 Pajak Kendaraan' : '🪪 Perpanjangan SIM';
    const sub = e.type === 'pajak' ? (e.plat || '') : (e.sim || '');

    // Normal thresholds (not H-7)
    if (days !== 7 && thresholds.includes(days)) {
      const key = `${e.id}_${days}_${today}`;
      if (!sentLog[key]) {
        sentLog[key] = true;
        const icon = days === 0 ? '⚠️' : days === 1 ? '🔴' : days <= 3 ? '🔴' : '🟡';
        const urgency = days === 0 ? '*HARI INI!*' : days === 1 ? '*BESOK!*' : `*${days} hari lagi*`;
        deadlineMsgs.push(
          `${icon} ${urgency}\n${typeName}: *${e.nama}*${sub ? ` (${sub})` : ''}\nDeadline: ${fmtDate(e.tgl)}`
        );
      }
    }

    // H-7: 3x per day
    if (days === 7 && thresholds.includes(7)) {
      const key = `${e.id}_7_${today}_${session}`;
      if (!sentLog[key]) {
        sentLog[key] = true;
        const sLabel = session === 'morning' ? '🌅 Pagi' : session === 'afternoon' ? '☀️ Siang' : '🌆 Sore';
        h7Msgs.push(
          `🟡 *7 hari lagi* [${sLabel}]\n${typeName}: *${e.nama}*${sub ? ` (${sub})` : ''}\nDeadline: ${fmtDate(e.tgl)}`
        );
      }
    }
  }

  // ── CHECK EVENTS ───────────────────────────────────────
  const EV_ICONS = {
    'ulang-tahun': '🎂',
    'anniversary': '💍',
    'hari-penting': '⭐',
    'lainnya': '📅'
  };

  for (const ev of events) {
    if (ev.sendWA === false) continue;

    const days = getEvDays(ev);
    if (!thresholds.includes(days)) continue;

    const key = `ev_${ev.id}_${days}_${today}`;
    if (sentLog[key]) continue;
    sentLog[key] = true;

    const nextDate = getEvNextDate(ev);
    const icon = EV_ICONS[ev.type] || '📅';
    const urgency = days === 0 ? '*HARI INI! 🎉*' : days === 1 ? '*BESOK!*' : `*${days} hari lagi*`;

    let msg = `${urgency}\n${icon} *${ev.nama}*`;

    // Calculate age/anniversary year
    if (ev.yearly && (ev.type === 'ulang-tahun' || ev.type === 'anniversary')) {
      const [baseYear] = ev.date.split('-').map(Number);
      const [nextYear] = nextDate.split('-').map(Number);
      const age = nextYear - baseYear;
      if (age > 0) {
        msg += ev.type === 'ulang-tahun'
          ? `\n🎈 Ulang tahun ke-${age}`
          : `\n💑 Anniversary ke-${age}`;
      }
    }

    msg += `\n📅 ${fmtDate(nextDate)}`;
    if (ev.note) msg += `\n📝 ${ev.note}`;

    eventMsgs.push(msg);
  }

  // ── SEND MESSAGES ──────────────────────────────────────
  let totalSent = 0;

  if (deadlineMsgs.length > 0) {
    const msg = `🚗 *PajakSIM Tracker — Pengingat Deadline*\n\n${deadlineMsgs.join('\n\n')}\n\n_Dikirim otomatis setiap hari 07:00 WIB_`;
    const ok = await sendWAToAll(msg, waConfig);
    if (ok) totalSent++;
    console.log('Deadline msgs sent:', ok, `(${deadlineMsgs.length} items)`);
  }

  if (h7Msgs.length > 0) {
    const msg = `🚗 *PajakSIM Tracker — H-7 Reminder*\n\n${h7Msgs.join('\n\n')}\n\n_Pesan ini dikirim 3x/hari karena kurang 7 hari._`;
    const ok = await sendWAToAll(msg, waConfig);
    if (ok) totalSent++;
    console.log('H7 msgs sent:', ok, `(${h7Msgs.length} items)`);
  }

  if (eventMsgs.length > 0) {
    const msg = `🎊 *PajakSIM Tracker — Hari Penting*\n\n${eventMsgs.join('\n\n')}\n\n_Dikirim otomatis setiap hari 07:00 WIB_`;
    const ok = await sendWAToAll(msg, waConfig);
    if (ok) totalSent++;
    console.log('Event msgs sent:', ok, `(${eventMsgs.length} items)`);
  }

  if (deadlineMsgs.length === 0 && h7Msgs.length === 0 && eventMsgs.length === 0) {
    console.log('No reminders due today');
  }

  // Save updated sent log
  await store.set('sent-log', JSON.stringify(sentLog));

  const summary = {
    today,
    session,
    deadlines: deadlineMsgs.length,
    h7: h7Msgs.length,
    events: eventMsgs.length,
    sent: totalSent
  };
  console.log('Summary:', summary);

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

export const config = {
  schedule: "0 0 * * *"   // 00:00 UTC = 07:00 WIB every day
};
