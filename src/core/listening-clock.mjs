// Time comes from monotonic playback samples, never from the seek position.
// A state-change sample closes the last fraction of a second before a skip/pause.
export class ListeningClock {
  constructor(){this.seconds=0;this.last=null;this.playing=false;}
  sample(now,playing,seeking=false){
    if(this.last!==null&&this.playing&&!seeking)this.seconds+=Math.max(0,Math.min(1.5,(now-this.last)/1000));
    this.last=now;this.playing=playing&&!seeking;
    return this.seconds;
  }
}
