import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {playerBrowserURL,playerRequestHeaders}=createRequire(import.meta.url)('../electron/player-links.cjs');
test('player sign-in and video links open only approved HTTPS sites',()=>{
  for(const url of ['https://accounts.google.com/ServiceLogin?service=youtube','https://www.youtube.com/watch?v=abcdefghijk','https://support.google.com/youtube/answer/3037019'])assert.equal(playerBrowserURL(url),url);
  for(const url of ['javascript:alert(1)','file:///C:/Windows/System32/cmd.exe','http://accounts.google.com/ServiceLogin','https://accounts.google.com.evil.test/','https://accounts.google.com@evil.test/','https://user:password@accounts.google.com/','https://accounts.google.com:8443/','https://evil.test/','https://youtube.com.evil.test/',null])assert.equal(playerBrowserURL(url),null);
});
test('YouTube internal requests retain their real Origin and Referer',()=>{
  const headers={Origin:'https://www.youtube.com',Referer:'https://www.youtube.com/embed/abcdefghijk'};
  assert.deepEqual(playerRequestHeaders({url:'https://www.youtube.com/youtubei/v1/player',resourceType:'xhr',requestHeaders:headers},'http://127.0.0.1:4123/'),headers);
  for(const resourceType of ['xhr','script','image'])assert.deepEqual(playerRequestHeaders({url:'https://www.youtube.com/embed/abcdefghijk',resourceType,requestHeaders:{}},'http://127.0.0.1:4123/'),{});
});
test('only a missing embed Referer uses the actual Forma origin',()=>{
  const details={url:'https://www.youtube.com/embed/abcdefghijk',resourceType:'subFrame',requestHeaders:{}};
  assert.deepEqual(playerRequestHeaders(details,'http://127.0.0.1:4123/index.html'),{Referer:'http://127.0.0.1:4123/'});
  const real={referer:'https://www.youtube.com/previous'};
  assert.deepEqual(playerRequestHeaders({...details,requestHeaders:real},'http://127.0.0.1:4123/'),real);
  assert.deepEqual(playerRequestHeaders({...details,url:'https://www.youtube.com/youtubei/v1/player'},'http://127.0.0.1:4123/'),{});
});
