// YouTube's desktop WebView identity is the installed app ID, expressed as
// HTTPS. It is an identifier, not a service to fetch or a postMessage origin.
export const desktopAppID='music.forma.desktop';
export const desktopPlayerIdentity=`https://${desktopAppID}/`;
export function youtubePlayerVars(pageURL,desktop=false){
  const page=new URL(pageURL);
  return {autoplay:0,playsinline:1,enablejsapi:1,origin:page.origin,
    widget_referrer:desktop?desktopPlayerIdentity:page.href,rel:0};
}
