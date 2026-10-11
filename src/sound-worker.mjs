import {analyzePCM} from './core/sound-profile.mjs';
self.onmessage=({data})=>{try{self.postMessage({profile:analyzePCM(data.pcm)});}catch{self.postMessage({profile:null});}};
