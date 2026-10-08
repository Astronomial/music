import {runRecommendationJob} from './recommendation-jobs.mjs';
self.onmessage=({data:{id,job}})=>{
  try{self.postMessage({id,result:runRecommendationJob(job)});}
  catch(error){self.postMessage({id,error:error.message});}
};
