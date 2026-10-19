const {spawn}=require('node:child_process');
function firewallScript(port){
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Некорректный порт обмена');
  return `$ErrorActionPreference='Stop'; Get-NetFirewallRule -Name 'Forma.LocalSync' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; New-NetFirewallRule -Name 'Forma.LocalSync' -DisplayName 'Forma local library sync' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -RemoteAddress LocalSubnet -Profile Private -EdgeTraversalPolicy Block | Out-Null`;
}
async function allowLocalSync(port){
  if(process.platform!=='win32')throw new Error('Настройка брандмауэра доступна в Windows.');
  const script=Buffer.from(firewallScript(port),'utf16le').toString('base64');
  const elevate=`$ErrorActionPreference='Stop'; try { $p=Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${script}'; exit $p.ExitCode } catch { exit 1 }`;
  await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(elevate,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore',timeout:90000});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Разрешение не применено. Подтверди запрос Windows и проверь, что домашняя сеть отмечена как частная.')));});
}
module.exports={firewallScript,allowLocalSync};
