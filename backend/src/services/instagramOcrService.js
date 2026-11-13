const { createWorker } = require('tesseract.js');

let workerPromise;
async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(process.env.TESSERACT_LANGUAGES || 'eng').catch((error) => { workerPromise = null; throw error; });
  }
  return workerPromise;
}
async function recognizeImage(buffer) {
  const worker = await getWorker();
  const result = await worker.recognize(buffer);
  return (result.data.text || '').replace(/\r/g, '').trim();
}
function dateParts(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}
function extractDates(text) {
  const candidates = [];
  const patterns = [
    { regex: /\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/g, convert: (m) => dateParts(+m[3], +m[2], +m[1]) },
    { regex: /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g, convert: (m) => dateParts(+m[1], +m[2], +m[3]) },
    { regex: /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(20\d{2})\b/gi, convert: (m) => dateParts(+m[3], new Date(`${m[2]} 1, 2000`).getMonth() + 1, +m[1]) },
    { regex: /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(20\d{2})\b/gi, convert: (m) => dateParts(+m[3], new Date(`${m[1]} 1, 2000`).getMonth() + 1, +m[2]) },
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern.regex)) {
    const date = pattern.convert(match);
    if (date && !candidates.some((entry) => entry.date.getTime() === date.getTime())) candidates.push({ date, index: match.index, raw: match[0] });
  }
  return candidates.sort((a, b) => a.index - b.index);
}
function inferEventDates(text) {
  const dates = extractDates(text); const lower = text.toLowerCase();
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const result = { dates: dates.map(({ date }) => date), eventName: null, venue: null, startTime: null, endTime: null, registrationDeadline: null, explicitExpiryDate: null, eventStartDate: null, eventEndDate: null, confidence: 'none', reason: '' };
  const tagged = dates.map((entry) => {
    let offset = 0; const line = lines.find((value) => { const found = text.indexOf(value, offset); if (found >= 0 && found <= entry.index && found + value.length >= entry.index) { offset = found + value.length; return true; } return false; }) || lower.slice(Math.max(0, entry.index - 45), Math.min(lower.length, entry.index + entry.raw.length + 45));
    const context = line.toLowerCase();
    return { ...entry, registration: /register|registration|apply by|last date to apply|deadline|sign.?up/.test(context), expiry: /offer|valid until|expires|expiry|sale ends|limited time/.test(context), event: /event|festival|conference|workshop|webinar|program|programme|celebration|ceremony|exhibition|summit/.test(context) };
  });
  const reg = tagged.find((d) => d.registration); const exp = tagged.find((d) => d.expiry);
  if (reg) result.registrationDeadline = reg.date;
  if (exp) result.explicitExpiryDate = exp.date;
  const eventDates = tagged.filter((d) => d.event && !d.registration && !d.expiry);
  const eventLine = lines.find((line) => /event|festival|conference|workshop|webinar|program|programme|celebration|ceremony|exhibition|summit/i.test(line) && !/date|starts?|ends?|from|to/i.test(line) && !/register|registration|venue|location/i.test(line));
  result.eventName = eventLine?.replace(/\s{2,}/g, ' ').slice(0, 180) || null;
  const venueLine = lines.find((line) => /\b(venue|location|held at|address)\b\s*[:\-]/i.test(line));
  result.venue = venueLine?.replace(/^.*?\b(?:venue|location|held at|address)\b\s*[:\-]\s*/i, '').slice(0, 240) || null;
  const times = [...text.matchAll(/\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/gi)].map((match) => match[1].replace(/\s+/g, '').toUpperCase().replace(/\./g, ''));
  if (times.length) result.startTime = times[0];
  if (times.length > 1) result.endTime = times[1];
  if (eventDates.length === 1 && dates.length === 1) {
    result.eventStartDate = eventDates[0].date; result.eventEndDate = eventDates[0].date; result.confidence = 'clear';
  } else if (eventDates.length === 2 && dates.length === 2 && eventDates[0].date <= eventDates[1].date) {
    result.eventStartDate = eventDates[0].date; result.eventEndDate = eventDates[1].date; result.confidence = 'clear';
  } else {
    result.reason = reg && dates.length === 1 ? 'Only a registration deadline was found; confirm the event end date.' : dates.length > 1 ? 'Multiple dates were found; confirm which date is the event end date.' : dates.length ? 'A date was found without a clear event date label; confirm the event end date.' : 'No reliable event date was found; enter the event end date.';
  }
  return result;
}
async function terminateWorker() {
  const worker = workerPromise; workerPromise = null;
  if (worker) { try { await (await worker).terminate(); } catch (error) { console.warn('[Instagram OCR] Worker shutdown failed:', error.message); } }
}
module.exports = { recognizeImage, inferEventDates, terminateWorker };
