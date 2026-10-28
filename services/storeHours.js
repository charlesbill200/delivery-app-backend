// services/storeHours.js
// Works out whether a store is inside its opening hours right now, in
// Nigerian time (Africa/Lagos). A store that has never saved opening hours
// has no limit. A day's hours can run past midnight: for example 18:00 to
// 02:00 belongs to that day and carries on into the next morning.

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function lagosNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    day: DAY_INDEX[get("weekday")],
    minutes: parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10),
  };
}

function toMinutes(time) {
  const [h, m] = String(time).split(":");
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

// rows: this store's saved hours (day_of_week 0 = Sunday to 6 = Saturday).
function withinHours(rows, now = lagosNow()) {
  if (!rows || rows.length === 0) return true; // no schedule saved: no limit

  const byDay = {};
  rows.forEach((r) => {
    byDay[r.day_of_week] = r;
  });
  const today = byDay[now.day];
  const yesterday = byDay[(now.day + 6) % 7];

  if (today && today.is_open) {
    const open = toMinutes(today.open_time);
    const close = toMinutes(today.close_time);
    if (open < close && now.minutes >= open && now.minutes < close) return true;
    if (open > close && now.minutes >= open) return true; // runs past midnight
  }
  if (yesterday && yesterday.is_open) {
    const open = toMinutes(yesterday.open_time);
    const close = toMinutes(yesterday.close_time);
    if (open > close && now.minutes < close) return true; // yesterday's late hours
  }
  return false;
}

// client can be the shared db helper or a transaction client.
async function isWithinOpeningHours(client, vendorId) {
  const result = await client.query(
    `SELECT day_of_week, is_open, open_time, close_time
     FROM vendor_opening_hours WHERE vendor_id = $1`,
    [vendorId],
  );
  return withinHours(result.rows);
}

module.exports = { withinHours, isWithinOpeningHours, lagosNow };