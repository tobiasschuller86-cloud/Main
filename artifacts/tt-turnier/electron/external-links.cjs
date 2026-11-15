function createWindowOpenHandler(openExternal) {
  return ({ url }) => {
    if (url.startsWith('https://github.com/')) {
      void openExternal(url);
    }
    return { action: 'deny' };
  };
}

async function openExternalSafely(url, openExternal) {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com') {
      return { success: false, message: 'Der Link verweist nicht auf GitHub und wurde nicht geöffnet.' };
    }
    await openExternal(parsedUrl.href);
    return { success: true };
  } catch {
    return { success: false, message: 'Der Link konnte nicht im Browser geöffnet werden. Prüfe die Standardbrowser-Einstellungen.' };
  }
}

module.exports = { createWindowOpenHandler, openExternalSafely };
