import React,{useEffect,useState} from 'react';
const labels={likesAdded:'Новые лайки',likesRemoved:'Снять лайки',dislikesAdded:'Новые дизлайки',dislikesRemoved:'Снять дизлайки',hiddenAdded:'Скрыть треки',hiddenRemoved:'Вернуть скрытые треки',playlistsAdded:'Новые плейлисты',playlistsRemoved:'Удалить плейлисты',playlistsChanged:'Изменить плейлисты',tracksAdded:'Новые треки',settingsChanged:'Настройки Пульса',soundProfilesChanged:'Профили звучания',historyAdded:'Добавить события истории',historyRemoved:'Удалить события истории'};
function Changes({title,summary={}}){return <div><h4>{title}</h4>{Object.keys(labels).some(k=>summary[k])?<ul>{Object.entries(labels).filter(([k])=>summary[k]>0).map(([k,label])=><li key={k}>{label}: {summary[k]}</li>)}</ul>:<p className="settings-note">Без изменений</p>}{summary.details?.length>0&&<details><summary>Какие треки и плейлисты</summary><ul>{summary.details.map((s,i)=><li key={i}>{s}</li>)}</ul></details>}</div>;}
export default function SyncSettings({bridge}){
  const [status,setStatus]=useState({enabled:false,devices:[],pending:[]}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{
    if(!bridge.syncStatus)return;
    let alive=true;
    const read=()=>bridge.syncStatus().then(s=>{if(alive)setStatus(s);}).catch(e=>{if(alive)setError(e.message);});
    read();const timer=setInterval(read,2000);return()=>{alive=false;clearInterval(timer);};
  },[bridge]);
  async function run(fn){setBusy(true);setError('');setNotice('');try{setStatus(await fn());return true;}catch(e){setError(e.message);return false;}finally{setBusy(false);}}
  async function copy(){try{await navigator.clipboard.writeText(status.pairing);setNotice('Код скопирован');}catch{setError('Выдели код и скопируй его вручную.');}}
  if(!bridge.desktop)return null;
  return <section className="settings-card" style={{marginBottom:24}}>
    <h2>iPhone и ПК · Wi-Fi</h2>
    <p>ПК — по Ethernet или Wi-Fi, iPhone — в Wi-Fi того же роутера. USB-кабель не заменяет сеть. Изменения применяются после подтверждения на одном устройстве.</p>
    <button className="button button-primary" disabled={busy} onClick={()=>run(status.enabled?bridge.syncStop:bridge.syncStart)}>{busy?'Подождём…':status.enabled?'Выключить синхронизацию':'Подключить iPhone'}</button>
    {status.enabled&&<>
      {status.address&&<p className="settings-note">Адрес ПК: {status.address}{status.port?`:${status.port}`:''}</p>}
      {(status.addresses||[]).length>1&&bridge.syncAddress&&<label>Сетевое подключение
        <select className="text-input" aria-label="Сетевое подключение ПК" value={status.address} disabled={busy} onChange={e=>run(()=>bridge.syncAddress(e.target.value))}>
          {status.addresses.map(a=><option key={a.address} value={a.address}>{a.name} · {a.address}{a.kind==='virtual'?' · виртуальная сеть':''}</option>)}
        </select>
      </label>}
      <p className="settings-note">На iPhone: Настройки → Синхронизация с ПК → вставить полный код. Телефон проверит локальные адреса и сертификат ПК.</p>
      {status.pairing?<>
        <textarea className="text-input" aria-label="Код подключения iPhone" readOnly value={status.pairing} rows={3} onFocus={e=>e.target.select()}/>
        <button className="button button-outline" disabled={busy} onClick={copy}>Скопировать код</button>
        <p className="settings-note">Код действует 5 минут. Соединение зашифровано.</p>
      </>:<p>{!status.address?'Подключи ПК к роутеру. Локальный адрес появится автоматически.':'Код использован или истёк.'}</p>}
      <button className="button button-outline" disabled={busy} onClick={()=>run(bridge.syncPair)}>Новый код</button>
      {status.canConfigureFirewall&&bridge.syncFirewall&&<>
        <button className="button button-outline" disabled={busy} onClick={async()=>{if(await run(bridge.syncFirewall))setNotice('Разрешение добавлено. Проверь соединение на iPhone.');}}>Разрешить обмен в брандмауэре</button>
        <p className="settings-note">Windows запросит права администратора. Разрешается только порт обмена из локальной подсети в частных сетях.</p>
      </>}
      <p>{status.devices.length?`Подключено: ${status.devices.map(d=>d.name).join(', ')}`:'Ожидаем iPhone'}</p>
      {status.devices.length>0&&<button className="text-link" disabled={busy} onClick={()=>run(bridge.syncForget)}>Отключить все телефоны</button>}
      {(status.pending||[]).map(p=><article key={p.id} className="settings-card" aria-label="Обмен ожидает подтверждения">
        <h3>Изменения · {p.deviceName}</h3><Changes title="На ПК" summary={p.summary.toPC}/><Changes title="На iPhone" summary={p.summary.toPhone}/>
        <p className="settings-note">Если библиотека изменится, обнови просмотр на iPhone.</p>
        <button className="button button-primary" disabled={busy} onClick={()=>run(()=>bridge.syncApprove(p.id))}>Применить на обоих устройствах</button>
        <button className="text-link" disabled={busy} onClick={()=>run(()=>bridge.syncReject(p.id))}>Отклонить обмен</button>
      </article>)}
    </>}
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
    <p className="settings-note">Передаются библиотека, оценки, история и настройки. Локальные файлы и ключи остаются на устройстве.</p>
  </section>;
}
