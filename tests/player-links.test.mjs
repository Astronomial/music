import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {desktopAppID,desktopPlayerIdentity,youtubePlayerVars} from '../src/core/youtube-player-config.mjs';
const {playerBrowserURL,playerRequestHeaders}=createRequire(import.meta.url)('../electron/player-links.cjs');
test('player sign-in and video links open only approved HTTPS sites',()=>{
  for(const url of ['https://accounts.google.com/ServiceLogin?service=youtube','https://www.youtube.com/watch?v=abcdefghijk','https://support.google.com/youtube/answer/3037019'])assert.equal(playerBrowserURL(url),url);
  for(const url of ['javascript:alert(1)','file:///C:/Windows/System32/cmd.exe','http://accounts.google.com/ServiceLogin','https://accounts.google.com.evil.test/','https://accounts.google.com@evil.test/','https://user:password@accounts.google.com/','https://accounts.google.com:8443/','https://evil.test/','https://youtube.com.evil.test/',null])assert.equal(playerBrowserURL(url),null);
});
test('YouTube internal requests retain their real Origin and Referer',()=>{
  const headers={Origin:'https://www.youtube.com',Referer:'https://www.youtube.com/embed/abcdefghijk'};
  assert.deepEqual(playerRequestHeaders({url:'https://www.youtube.com/youtubei/v1/player',resourceType:'xhr',requestHeaders:headers},'http://127.0.0.1:4123/',desktopPlayerIdentity),headers);
  for(const resourceType of ['xhr','script','image'])assert.deepEqual(playerRequestHeaders({url:'https://www.youtube.com/embed/abcdefghijk',resourceType,requestHeaders:{}},'http://127.0.0.1:4123/',desktopPlayerIdentity),{});
});
test('initial desktop embed uses the HTTPS app ID instead of a loopback identity',()=>{
  const details={url:'https://www.youtube.com/embed/abcdefghijk',resourceType:'subFrame',requestHeaders:{}};
  const apply=details=>playerRequestHeaders(details,'http://127.0.0.1:4123/index.html',desktopPlayerIdentity);
  for(const requestHeaders of [{},{Referer:'http://127.0.0.1:4123/'},{referer:'http://127.0.0.1:4123/index.html'},{referer:'',REFErer:''}])assert.deepEqual(apply({...details,requestHeaders}),{Referer:desktopPlayerIdentity});
  assert.deepEqual(apply({...details,url:'https://www.youtube-nocookie.com/embed/abcdefghijk'}),{Referer:desktopPlayerIdentity});
  const real={referer:'https://www.youtube.com/previous'};
  assert.deepEqual(apply({...details,requestHeaders:real}),real);
  for(const url of ['https://www.youtube.com/youtubei/v1/player','https://www.youtube.com/embed/not-valid','https://www.youtube.com.evil.test/embed/abcdefghijk','http://www.youtube.com/embed/abcdefghijk'])assert.deepEqual(apply({...details,url}),{});
});
test('desktop identity and the real postMessage origin have distinct roles',()=>{
  assert.equal(desktopPlayerIdentity,`https://${desktopAppID}/`);
  const entry='http://127.0.0.1:4123/index.html';
  assert.equal(youtubePlayerVars(entry,true).origin,'http://127.0.0.1:4123');
  assert.equal(youtubePlayerVars(entry,true).widget_referrer,desktopPlayerIdentity);
  assert.equal(youtubePlayerVars(entry,false).widget_referrer,entry);
  const web='https://example.org/music';assert.equal(youtubePlayerVars(web,false).origin,'https://example.org');assert.equal(youtubePlayerVars(web,false).widget_referrer,web);
});
