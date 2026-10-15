// Actual browser decoding and clocks; only the catalogue and network are fixtures.
export function installAudioFixture(){
 const bytes=new Uint8Array(44+16000*210),v=new DataView(bytes.buffer),text=(at,s)=>{for(let i=0;i<s.length;i++)bytes[at+i]=s.charCodeAt(i);};
 text(0,'RIFF');v.setUint32(4,bytes.length-8,true);text(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,bytes.length-44,true);
 for(let i=44;i<bytes.length;i+=2)v.setInt16(i,Math.round(Math.sin(i/16)*1000),true);
 const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
 window.forma.sources=async()=>[url];window.forma.prepareAudio=async()=>{};
 window.nativeAudio={get id(){return document.querySelector('audio')?.dataset.trackId?.replace(/^yt_/,'')||'';},get state(){const a=document.querySelector('audio');return a&&!a.paused?1:2;},get volume(){return document.querySelector('audio').volume*100;},getPlayerState(){return this.state;},getCurrentTime(){return document.querySelector('audio').currentTime;},getDuration(){return document.querySelector('audio').duration;}};
}
