// Drive the logged-in Telegram Web tab: open a chat and send text.
// One-off admin steps (rename a channel, talk to @BotFather) are sequences of these calls.
// import { openChat, sendText, latestMessage, clickLabel } from './telegram_web.mjs';

import { connect, sleep } from './chrome_cdp.mjs';

async function tab() {
  const c = await connect(u => u.includes('web.telegram.org'));
  await c.send('Page.bringToFront');
  return c;
}

export async function openChat(url) {
  const c = await tab();
  await c.send('Page.navigate', { url });
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    if (await c.ev(`!!document.querySelector('#editable-message-text, .MiddleHeader h3')`)) break;
  }
  return c;
}

export async function latestMessage(c) {
  const text = await c.ev(`(() => {
    const msgs = [...document.querySelectorAll('.Message.message-list-item')];
    const m = msgs.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom).at(-1);
    return m ? (m.innerText || '') : '';
  })()`);
  return (text || '').replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '<TOKEN>');
}

export async function sendText(c, text) {
  const before = await latestMessage(c);
  const box = await c.ev(`(() => {
    const e = document.querySelector('#editable-message-text');
    if (!e) return null;
    e.focus();
    const r = e.getBoundingClientRect();
    return { x: r.x + 40, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error('Telegram composer is not open');
  await c.click(box.x, box.y);
  await c.key('a', 'KeyA', 65, 2);
  await c.key('Backspace', 'Backspace', 8);
  await c.type(text);
  await sleep(150);
  await c.key('Enter', 'Enter', 13);
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const now = await latestMessage(c);
    if (now && now !== before && !now.startsWith(text.slice(0, 30))) return now;
  }
  return latestMessage(c);
}

export async function clickLabel(c, label) {
  const point = await c.ev(`(() => {
    const hit = [...document.querySelectorAll('button, a, [role=button], div, span, h3')]
      .filter(e => (e.innerText || '').trim() === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0)
      .sort((a, b) => a.innerText.length - b.innerText.length)[0];
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!point) return false;
  await c.click(point.x, point.y);
  return true;
}

export { sleep };
