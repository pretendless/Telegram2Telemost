// Texts the browser job sends into Telegram. The account label is already validated.

import { vncPage } from "./public_url.js";

export function qrCaption(account, n) {
  return (
    `Яндекс ID, аккаунт «${account}», код ${n}.\n` +
    "Откройте приложение Яндекс и отсканируйте QR. Если картинка сменится, пришлю новую."
  );
}

export function linkText(origin, password) {
  const page = vncPage(origin);
  if (!page) return "";
  return (
    "Если QR не сканируется, откройте экран браузера. Ссылка одноразовая и живёт, пока этот запуск не закончится:\n" +
    `${page}\n` +
    `Пароль: ${password}`
  );
}

export function resultText(kind, account) {
  if (kind === "ready") {
    return `Вход выполнен, аккаунт «${account}». Сессия зашифрована и сохранена. Телемост открылся.`;
  }
  if (kind === "connecting") {
    return `Вход выполнен, аккаунт «${account}». Сессия сохранена, но Телемост всё ещё пишет «Подключение…».`;
  }
  if (kind === "timeout") {
    return `Вход не завершился, аккаунт «${account}». Сессия не сохранена.`;
  }
  if (kind === "no-session") {
    return `Нет сохранённой сессии для аккаунта «${account}». Сначала отправьте /login.`;
  }
  if (kind === "upload-ready") {
    return `Сессия аккаунта «${account}» открыта, Телемост на связи. Начинаю загрузку.`;
  }
  return `Браузер остановился, аккаунт «${account}».`;
}
