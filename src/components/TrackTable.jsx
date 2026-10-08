import React,{memo,useRef} from 'react';
import {AudioLines,Play,Heart,LoaderCircle,Check,ArrowDownToLine,MoreHorizontal} from 'lucide-react';
const fmt=s=>`${Math.floor((s||0)/60)}:${String(Math.floor((s||0)%60)).padStart(2,'0')}`;
// A clock tick only redraws the active row; callbacks read the current table and
// action refs, so memoization cannot leave an old playlist queue in a closure.
const TrackRow=memo(function TrackRow({track:t,index,isCurrent,isPlaying,liked,downloaded,progress,reason,table,actions,Cover,IconButton}){
  const play=()=>actions.current.playTrack(t,table.current.tracks,{playbackContext:table.current.playbackContext});
  return <div className={`track-row ${!t.streamable?'unavailable':''} ${isCurrent?'is-current':''}`}>
    <button className="track-number" disabled={!t.streamable} aria-label={`Слушать ${t.title}`} onClick={play}>{isPlaying?<AudioLines size={17}/>:<><span>{String(index+1).padStart(2,'0')}</span><Play className="row-play" size={15} fill="currentColor"/></>}</button>
    <button className="track-name" aria-label={!t.streamable?`${t.title} — версия ещё не найдена`:undefined} onClick={play}><Cover track={t}/><span><strong>{t.title}</strong><small>{t.artist}{downloaded&&<Check size={11} className="download-mark"/>}</small></span></button>
    <span className="genre-column row-reason">{!t.streamable?'Нужна версия в YouTube':reason||t.genre||'—'}</span><span className="track-time">{fmt(t.duration)}</span>
    <div className="track-actions"><IconButton title={liked?`Убрать ${t.title} из любимого`:`Нравится ${t.title}`} active={liked} onClick={()=>actions.current.toggleLike(t)}><Heart size={17} fill={liked?'currentColor':'none'}/></IconButton>
      {progress?<IconButton title="Отменить загрузку" onClick={()=>actions.current.cancelDownload(t.id)}><LoaderCircle size={16} className="spin"/></IconButton>:<IconButton title={downloaded?'Скачано':t.downloadable?`Скачать ${t.title}`:t.source==='youtube'?'Музыка из YouTube слушается онлайн':'Автор отключил скачивание'} disabled={!t.downloadable||downloaded} onClick={()=>actions.current.downloadTrack(t)}>{downloaded?<Check size={16}/>:<ArrowDownToLine size={16}/>}</IconButton>}
      <IconButton title={`Действия с треком ${t.title}`} onClick={()=>actions.current.showTrackMenu(t,table.current)}><MoreHorizontal size={18}/></IconButton>
    </div>
  </div>;
});
export default function TrackTable({tracks,reasons={},playlist=null,downloaded=false,playbackContext=null,current,playing,likes,downloads,progress,actions,Cover,IconButton}){
  const table=useRef(null);table.current={tracks,playlist,downloaded,playbackContext};const liked=new Set(likes);
  return <div className="track-table"><div className="track-table-head"><span>#</span><span>ТРЕК / ИСПОЛНИТЕЛЬ</span><span className="genre-column">{Object.keys(reasons).length?'ДЛЯ ТЕБЯ':'ЖАНР'}</span><span>ВРЕМЯ</span><span/></div>{tracks.map((track,index)=><TrackRow key={track.id} track={track} index={index} isCurrent={current?.id===track.id} isPlaying={current?.id===track.id&&playing} liked={liked.has(track.id)} downloaded={Boolean(downloads[track.id])} progress={Boolean(progress[track.id])} reason={reasons[track.id]} table={table} actions={actions} Cover={Cover} IconButton={IconButton}/>)}</div>;
}
