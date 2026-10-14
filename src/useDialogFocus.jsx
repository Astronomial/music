import {useEffect,useRef} from 'react';

// Remember the opener before React autofocus runs, including chained dialogs.
export default function useDialogFocus(open,onEscape){
  const opener=useRef(null),escape=useRef(onEscape);escape.current=onEscape;
  useEffect(()=>{
    const remember=e=>{if(!e.target.closest('.modal'))opener.current=e.target;};
    document.addEventListener('focusin',remember);return()=>document.removeEventListener('focusin',remember);
  },[]);
  useEffect(()=>{
    if(!open)return;
    const dialog=document.querySelector('.modal'),previous=opener.current;
    if(!dialog)return;
    const controls=()=>[...dialog.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]')].filter(el=>el.tabIndex>=0&&!el.matches(':disabled')&&el.checkVisibility({visibilityProperty:true}));
    if(!dialog.contains(document.activeElement))(controls()[0]||dialog).focus();
    const key=e=>{
      if(e.defaultPrevented)return;
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();escape.current();}
      if(e.key==='Tab'){
        const elements=controls(),first=elements[0],last=elements.at(-1);
        if(!first){e.preventDefault();dialog.focus();}
        else if(!dialog.contains(document.activeElement)){e.preventDefault();(e.shiftKey?last:first).focus();}
        else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('keydown',key);requestAnimationFrame(()=>{
      if(document.querySelector('.modal'))return;
      const fallback=document.querySelector('.sidebar [aria-current=page]')||document.querySelector('.sidebar-toggle');
      (previous?.isConnected&&!previous.closest('[inert]')?previous:fallback)?.focus({preventScroll:true});
    });};
  },[open]);
}
