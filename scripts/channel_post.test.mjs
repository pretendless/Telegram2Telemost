import assert from 'node:assert/strict';
import test from 'node:test';
import { postPackLink } from './telemost_upload.mjs';

const PACK_URL = 'https://messenger.360.yandex.ru/#/stickers/8506';

test('postPackLink sends the compact HTML post and disables the preview', async () => {
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await postPackLink(fetchImpl, 'token', 'Шерсть Ебаная', PACK_URL, {
    total: 109,
    links: ['https://t.me/addstickers/piidarasy', 'https://t.me/addstickers/second'],
  });
  assert.equal(body.chat_id, '@tg2tm');
  assert.equal(body.parse_mode, 'HTML');
  assert.equal(body.link_preview_options.is_disabled, true);
  assert.equal(
    body.text,
    '📞 <b>Шерсть Ебаная</b> · 109 стикеров\n' +
      `<a href="${PACK_URL}">Открыть в Телемосте</a> · из тг ` +
      '<a href="https://t.me/addstickers/piidarasy">#</a> ' +
      '<a href="https://t.me/addstickers/second">#</a>',
  );
  assert.doesNotMatch(body.text, /github\.com/);
});
