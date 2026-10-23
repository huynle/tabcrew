/**
 * Page-side scripts, evaluated with CDP `Runtime.evaluate` in the tab's main world.
 *
 * SNAPSHOT_SOURCE is a port of jev-ultrafast `snapshot.js`: one atomic read of the visible text
 * and the actionable controls, keeping live node identity in a WeakMap on `window.__tabcrewJev`.
 * TabCrew additions: elements and text clipped by an overflow ancestor are left out (unless on
 * top at their centre), an open modal hides what lies behind it and its text comes first, and up
 * to 5 scroll areas (dialogs, panels) get their own scroll actions and are part of the marker,
 * the page key and the fingerprint (`scroll.areas`). The other scripts are the freshness, target and settle checks from
 * jev-ultrafast `browser.py`. Each expression starts with a `/*cu:<name>*\/` tag so tests and
 * logs can tell them apart. They are plain JS strings (not `fn.toString()`) so bundling can
 * never rewrite them.
 */

export const CACHE = "__tabcrewJev";

/** Evaluates to the raw snapshot object, or null while the document has no body (navigating). */
export const SNAPSHOT_SOURCE = String.raw`/*cu:snapshot*/(() => {
  if (!document.body) return null;
  const cache = window.${CACHE} ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  // Clipping: the part of the viewport where an element can be seen, after every ancestor with
  // overflow other than visible (fixed elements escape ancestors, absolute ones skip static ones).
  const meet=(a,b)=>({l:Math.max(a.l,b.l),t:Math.max(a.t,b.t),r:Math.min(a.r,b.r),b:Math.min(a.b,b.b)});
  const box=r=>({l:r.left,t:r.top,r:r.right,b:r.bottom});
  const inside=(c,x,y)=>x>=c.l && x<c.r && y>=c.t && y<c.b;
  cache.clipper=()=>{
    const view={l:0,t:0,r:innerWidth,b:innerHeight}, memo=new Map();
    const pick=(s,p)=>s.position==='fixed' ? view : s.position==='absolute' ? p[1] : p[0];
    const clips=e=>{
      if (!e || e===document.documentElement || e===document.body) return [view,view];
      let c=memo.get(e);
      if (c) return c;
      const s=getComputedStyle(e), base=pick(s,clips(e.parentElement));
      const own=s.display!=='contents' && (s.overflowX!=='visible' || s.overflowY!=='visible') ?
        meet(base,box(e.getBoundingClientRect())) : base;
      c=[own, s.position!=='static' || s.transform!=='none' ? own : clips(e.parentElement)[1]];
      memo.set(e,c);
      return c;
    };
    return {of:e=>pick(getComputedStyle(e),clips(e.parentElement)), content:e=>clips(e)[0]};
  };
  const clip=cache.clipper();
  const hits=(e,x,y)=>e.contains(document.elementFromPoint(x,y));
  // The topmost open modal: on top at its centre (or the viewport centre), and either declared
  // modal or surrounded by a backdrop (every viewport corner shows the dialog or an overlay).
  const backdrop=d=>{
    const w=document.documentElement.clientWidth||innerWidth, h=document.documentElement.clientHeight||innerHeight;
    return [[4,4],[w-5,4],[4,h-5],[w-5,h-5]].every(([x,y])=>{
      const hit=document.elementFromPoint(x,y);
      if (!hit || d.contains(hit)) return !!hit;
      for (let a=hit, i=0; a && a!==document.body && a!==document.documentElement && i<4; a=a.parentElement, i++) {
        const r=a.getBoundingClientRect();
        if (r.width>=w*0.9 && r.height>=h*0.9 && [...a.querySelectorAll(selector)].every(x=>d.contains(x))) return true;
      }
      return false;
    });
  };
  let modal=null;
  for (const d of document.querySelectorAll('dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"]')) {
    if (!visible(d)) continue;
    const v=meet(clip.of(d),box(d.getBoundingClientRect()));
    const onTop=(v.r>v.l && v.b>v.t && hits(d,(v.l+v.r)/2,(v.t+v.b)/2)) || hits(d,innerWidth/2,innerHeight/2);
    if (onTop && (d.matches(':modal,[aria-modal="true"]') || backdrop(d))) modal=d;
  }
  const areaName=e=>{
    const ref=(e.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean)
      .map(id=>document.getElementById(id)?.textContent||'').join(' ');
    const h=e.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],legend');
    return (ref.trim() || e.getAttribute('aria-label') || h?.textContent || '').replace(/\s+/g,' ').trim().slice(0,60);
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly]),
    (cache.areas||[]).map(id=>{const e=cache.nodes.get(id); return [id,e?.isConnected ? Math.round(e.scrollTop) : null];})];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const actions=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    // Behind an open modal, or clipped by a scroll area: offered only if it is on top at its centre.
    if (((modal && !modal.contains(e)) || !inside(clip.of(e),x,y)) && !hits(e,x,y)) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  // Visible text, the open modal's first.
  const words=[], range=document.createRange(); let length=0;
  const read=(root,skip)=>{
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); let node;
    while ((node=walker.nextNode()) && length<6000) {
      const value=node.textContent.trim(), parent=node.parentElement;
      if (!value || !parent || skip?.contains(parent) || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
      range.selectNodeContents(node);
      const r=meet(clip.content(parent),box(range.getBoundingClientRect()));
      if (r.r>r.l && r.b>r.t) { words.push(value); length+=value.length; }
    }
  };
  if (modal) read(modal);
  read(document.body,modal);
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  // Scroll areas (overflow auto/scroll with more content than fits), at most 5: the open modal's
  // (it or an ancestor/descendant of it) first, then the one under the viewport centre, then by size.
  // Behind a modal only areas that are on top themselves count.
  const centre=document.elementFromPoint(innerWidth/2,innerHeight/2), found=[];
  for (const e of document.body.getElementsByTagName('*')) {
    if (e.clientHeight<40 || e.scrollHeight<=e.clientHeight+2 || ['TEXTAREA','SELECT'].includes(e.tagName)) continue;
    if (!['auto','scroll','overlay'].includes(getComputedStyle(e).overflowY) || !visible(e)) continue;
    const v=meet(clip.of(e),box(e.getBoundingClientRect()));
    if (v.r-v.l<40 || v.b-v.t<40) continue;
    const related=!!modal && (modal.contains(e) || e.contains(modal));
    if (modal && !related && !hits(e,(v.l+v.r)/2,(v.t+v.b)/2)) continue;
    found.push({e,v,rank:related ? 0 : e.contains(centre) ? 1 : 2,area:(v.r-v.l)*(v.b-v.t)});
  }
  found.sort((a,b)=>a.rank-b.rank || b.area-a.area);
  const areas=found.slice(0,5).map((a,i)=>({...a,n:i+1,node:identity(a.e)}));
  cache.areas=areas.map(a=>a.node);
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6],page_key[7]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  // Page scroll: unchanged without a modal; behind one, last and only if the page is not locked.
  const locked=[document.documentElement,document.body].some(e=>['hidden','clip'].includes(getComputedStyle(e).overflowY));
  const pageScroll=()=>{
    if (modal && locked) return;
    const where=modal ? ' the page' : '';
    if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down'+where,delta:560});
    if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up'+where,delta:-560});
  };
  const areaScroll=()=>{
    const modalName=modal ? areaName(modal) : '';
    for (const a of areas) {
      const related=a.rank===0, name=related ? modalName || areaName(a.e) : areaName(a.e);
      const where=name ? ' in "'+name+'" '+(related ? 'dialog' : 'panel') : related ? ' in the dialog' : ' in a scrollable panel';
      const step=Math.max(40,Math.round((a.v.b-a.v.t)*0.8)), top=a.e.scrollTop;
      if (top+a.e.clientHeight<a.e.scrollHeight-2)
        actions.push({id:'scroll_down_'+a.n,kind:'scroll',label:'Scroll down'+where,node:a.node,delta:step});
      if (top>0) actions.push({id:'scroll_up_'+a.n,kind:'scroll',label:'Scroll up'+where,node:a.node,delta:-step});
    }
  };
  if (modal) { areaScroll(); pageScroll(); } else { pageScroll(); areaScroll(); }
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  const scroll={y:scrollY,height};
  if (areas.length) scroll.areas=areas.map(a=>[a.node,Math.round(a.e.scrollTop),a.e.scrollHeight]);
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll,actions,marker,page_key,guards,omitted_actions};
})()`;

/** Full-marker freshness (fill / scroll / wait): re-read the page and return only its marker. */
export const MARKER_SOURCE = `/*cu:marker*/(() => { const state=${SNAPSHOT_SOURCE}; return state?.marker ?? null; })()`;

/** Click/select freshness: current page key plus the guard of that one node. */
export function guardSource(node: number): string {
  return `/*cu:guard*/(() => { const c=window.${CACHE}; return c ? [c.pageKey(),c.guard(c.nodes.get(${JSON.stringify(node)}))] : null; })()`;
}

export interface TargetAction {
  readonly node: number;
  readonly kind: "click" | "fill" | "select";
  readonly value?: string;
}

/**
 * Re-resolve the observed node immediately before input and check that it can be operated:
 * connected, enabled, visible, editable (fill), centre inside the viewport and every clipping
 * ancestor, not covered at its centre, and (select) that the observed option still exists. If
 * the centre is off-screen, clipped by a scroll area or covered, the target is first scrolled
 * into view (block centre) and re-checked after the page repaints; the result then carries
 * `revealed: true`. For select this same evaluation then sets the value and fires input/change,
 * so the check and the mutation are atomic. Resolves to `{x,y[,revealed]}` or
 * `{error, message[,revealed]}`; evaluate it with awaitPromise.
 */
export function targetSource(action: TargetAction): string {
  const arg = JSON.stringify({ node: action.node, kind: action.kind, value: action.value ?? null });
  return String.raw`/*cu:target*/(async action => {
  const c=window.${CACHE}, e=c?.nodes.get(action.node);
  let revealed=false;
  const fail=(error,message)=>revealed ? {error,message,revealed} : {error,message};
  if (!e?.isConnected) return fail('stale_page','The target is no longer in the page. Observe again.');
  if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]'))
    return fail('target_invalid','The target is disabled.');
  if (!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))
    return fail('target_invalid','The target is hidden.');
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true'))
    return fail('target_invalid','The target field is read-only.');
  const where=()=>{
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    if (!r.width || !r.height) return {x,y,problem:'empty'};
    if (x<0 || y<0 || x>=innerWidth || y>=innerHeight) return {x,y,problem:'outside'};
    const k=c.clipper?.().of(e);
    if (k && !(x>=k.l && x<k.r && y>=k.t && y<k.b)) return {x,y,problem:'outside'};
    if (!e.contains(document.elementFromPoint(x,y))) return {x,y,problem:'covered'};
    return {x,y};
  };
  let p=where();
  if (p.problem && p.problem!=='empty') {
    e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    const r=e.getBoundingClientRect();
    revealed=r.x+r.width/2!==p.x || r.y+r.height/2!==p.y;
  }
  if (revealed) {
    await new Promise(done=>{
      let frames=0;
      const frame=()=>++frames>=2 ? done() : requestAnimationFrame(frame);
      requestAnimationFrame(frame);
      setTimeout(done,100);
    });
    p=where();
  }
  if (p.problem==='empty' || p.problem==='outside') return fail('target_invalid','The target is outside the viewport.');
  if (p.problem==='covered') return fail('target_covered','Another element covers the target.');
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]')))
      return fail('target_invalid','The observed option is no longer available.');
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return revealed ? {x:p.x,y:p.y,revealed} : {x:p.x,y:p.y};
})(${arg})`;
}

/**
 * Container scroll, read-only part: find a point inside the area's visible part where a wheel
 * reaches the area itself (not a nested scroller, iframe or overlay). Returns `{x,y,top}`,
 * `{x:null,top}` when there is no such point, or `{error,message}`. `top` is its scrollTop now.
 */
export function scrollPointSource(a: { node: number; delta: number }): string {
  const arg = JSON.stringify({ node: a.node, delta: a.delta });
  return String.raw`/*cu:scrollpoint*/(a => {
  const c=window.${CACHE}, e=c?.nodes.get(a.node);
  if (!e?.isConnected) return {error:'stale_page',message:'The scroll area is no longer in the page. Observe again.'};
  if (!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))
    return {error:'target_invalid',message:'The scroll area is hidden.'};
  const top=e.scrollTop, r=e.getBoundingClientRect();
  const k=c.clipper?.().of(e) ?? {l:0,t:0,r:innerWidth,b:innerHeight};
  const v={l:Math.max(r.left,k.l),t:Math.max(r.top,k.t),r:Math.min(r.right,k.r),b:Math.min(r.bottom,k.b)};
  if (v.r-v.l<2 || v.b-v.t<2) return {x:null,top};
  const scrolls=s=>s.scrollHeight>s.clientHeight+2 &&
    ['auto','scroll','overlay'].includes(getComputedStyle(s).overflowY) &&
    (a.delta>0 ? s.scrollTop+s.clientHeight<s.scrollHeight-1 : s.scrollTop>0);
  for (const [fx,fy] of [[.5,.5],[.5,.25],[.5,.75],[.25,.5],[.75,.5],[.1,.1],[.9,.9]]) {
    const x=Math.round(v.l+(v.r-v.l)*fx), y=Math.round(v.t+(v.b-v.t)*fy), hit=document.elementFromPoint(x,y);
    if (!hit || !e.contains(hit) || hit.tagName==='IFRAME') continue;
    let s=hit;
    while (s!==e && !scrolls(s)) s=s.parentElement;
    if (s===e) return {x,y,top};
  }
  return {x:null,top};
})(${arg})`;
}

/**
 * Container scroll, after the wheel (or instead of it): wait until the area's scrollTop moved
 * away from `top` and settled; if it has not moved (no wheel, or ~150 ms without effect), scroll
 * it by `delta` directly. Resolves to `{top, by:"wheel"|"script"}`, or null if the area is gone.
 */
export function scrolledSource(a: { node: number; top: number; delta: number; wheel: boolean }): string {
  const arg = JSON.stringify({ node: a.node, top: a.top, delta: a.delta, wheel: a.wheel });
  return String.raw`/*cu:scrolled*/(a => new Promise(resolve => {
  const e=window.${CACHE}?.nodes.get(a.node);
  if (!e?.isConnected) return resolve(null);
  const started=Date.now();
  let last=e.scrollTop, still=0;
  const tick=()=>{
    const now=e.scrollTop, waited=Date.now()-started;
    if (now===a.top) {
      if (!a.wheel || waited>=150) {
        e.scrollBy({top:a.delta,behavior:'instant'});
        return resolve({top:e.scrollTop,by:'script'});
      }
    } else if ((now===last && ++still>=2) || waited>=600) return resolve({top:now,by:'wheel'});
    if (now!==last) still=0;
    last=now;
    setTimeout(tick,16);
  };
  tick();
}))(${arg})`;
}

/**
 * Post-input settle wait (read-only). Combobox fill: up to 200 ms for a visible [role=option]
 * inside aria-controls/aria-owns (or the document). Everything else: two animation frames,
 * capped at 50 ms.
 */
export function settleSource(action: { node?: number; kind: string }): string {
  const arg = JSON.stringify({ node: action.node ?? null, kind: action.kind });
  return String.raw`/*cu:settle*/(action => new Promise(resolve => {
  const field=window.${CACHE}?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve(true)};
  setTimeout(finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))(${arg})`;
}
