let runtimeModule;
// Untrusted player JavaScript runs in WebAssembly without Node, DOM or network.
async function evaluateSignature(data){
  if(typeof data?.output!=='string'||data.output.length>8*1024*1024)throw new Error('Invalid player script');
  runtimeModule ||= import('quickjs-emscripten').then(m=>m.getQuickJS()).catch(e=>{runtimeModule=null;throw e;});
  const module=await runtimeModule,runtime=module.newRuntime();
  runtime.setMemoryLimit(64*1024*1024);runtime.setMaxStackSize(1024*1024);
  const deadline=Date.now()+250;runtime.setInterruptHandler(()=>Date.now()>deadline);
  const context=runtime.newContext();let result;
  try{
    result=context.evalCode(`globalThis.window=globalThis;globalThis.self=globalThis;globalThis.navigator={userAgent:'Mozilla/5.0'};globalThis.location={href:'https://www.youtube.com/',origin:'https://www.youtube.com'};(()=>{${data.output}\n})()`);
    if(result.error)throw new Error('Player script evaluation failed');
    const value=context.dump(result.value);
    if(!value||typeof value!=='object')throw new Error('Invalid player signature');
    return {n:typeof value.n==='string'?value.n:undefined,sig:typeof value.sig==='string'?value.sig:undefined};
  }finally{result?.value?.dispose();result?.error?.dispose();context.dispose();runtime.dispose();}
}
module.exports={evaluateSignature};
