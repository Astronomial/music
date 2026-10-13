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
function playerRequestHeaders(details, entry, identity) {
  const headers=details.requestHeaders;
  // Only the initial embed request identifies the desktop app. YouTube's own
  // nested navigation/API/media requests retain their real Origin and Referer.
  if(details.resourceType !== 'subFrame')return headers;
  try {
    const url=new URL(details.url),source=new URL(entry),app=new URL(identity);
    if(url.protocol!=='https:'||!['www.youtube.com','youtube.com','www.youtube-nocookie.com','youtube-nocookie.com'].includes(url.hostname)||!/^\/embed\/[\w-]{11}$/.test(url.pathname)||app.protocol!=='https:'||app.username||app.password||app.port)return headers;
    const refs=Object.entries(headers).filter(([key])=>key.toLowerCase()==='referer');
    if(refs.some(([,value])=>value&&new URL(value).origin!==source.origin))return headers;
    const next={...headers};for(const [key] of refs)delete next[key];
    return {...next,Referer:app.origin+'/'};
  } catch { }
  return headers;
}
module.exports = { playerBrowserURL, playerRequestHeaders };
