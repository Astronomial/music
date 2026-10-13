// The player can ask to open sign-in/help/video links. It must never create an
// Electron login window or launch arbitrary protocols from remote content.
function playerBrowserURL(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!['youtube.com','www.youtube.com','m.youtube.com','accounts.google.com','support.google.com','consent.youtube.com'].includes(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
function playerRequestHeaders(details, entry) {
  const headers=details.requestHeaders;
  // Preserve YouTube's own Origin/Referer and the browser's normal navigation
  // headers. Only fill a missing identity on the actual embedded video request.
  if(details.resourceType !== 'subFrame' || Object.keys(headers).some(key=>key.toLowerCase()==='referer'&&headers[key]))return headers;
  try {
    const url=new URL(details.url), source=new URL(entry);
    if(url.protocol==='https:' && ['www.youtube.com','youtube.com','www.youtube-nocookie.com','youtube-nocookie.com'].includes(url.hostname) && url.pathname.startsWith('/embed/'))return {...headers,Referer:source.origin+'/'};
  } catch { }
  return headers;
}
module.exports = { playerBrowserURL, playerRequestHeaders };
