// In-frame click bridge injected into the sandboxed email iframe.
//
// WKWebView (macOS) does not deliver click events to a listener the parent
// attaches on the iframe's contentDocument, so the click must be handled from
// INSIDE the frame and the target relayed to the parent via postMessage. The
// parent then opens the link with the opener plugin. Works on both WKWebView
// and WebView2.
//
// The srcdoc iframe is a separate document, so the parent-window guard in
// `browserKeyGuard.ts` never sees keys typed while the mail body has focus —
// this script also blocks the same browser-chrome keys locally (no forwarding
// to the parent needed, preventDefault here is enough).
//
// IMPORTANT — CSP: a `srcdoc` iframe inherits the parent document's CSP. The
// production CSP in `src-tauri/tauri.conf.json` pins `script-src`,
// so this exact script is allow-listed there by its SHA-256 hash
// (MAIL_LINK_BRIDGE_CSP_HASH). If you change MAIL_LINK_BRIDGE, regenerate the
// hash and update BOTH this constant AND the `script-src` entry in
// tauri.conf.json, or links will silently stop opening in production builds
// (dev does not enforce the CSP, so it would still appear to work there).
//
// Regenerate the hash:
//   node -e "const c=require('crypto');const m=require('fs').readFileSync('src/lib/mailLinkBridge.ts','utf8').match(/MAIL_LINK_BRIDGE = \`([\s\S]*?)\`;/)[1];console.log('sha256-'+c.createHash('sha256').update(m,'utf8').digest('base64'))"

export const MAIL_LINK_BRIDGE = `(function(){document.addEventListener('click',function(e){var t=e.target;if(t&&t.tagName==='IMG'&&(!t.closest||!t.closest('a'))){var s=t.currentSrc||t.src;if(s){e.preventDefault();try{parent.postMessage({__prudiiImage:s},'*');}catch(_){}}return;}var a=t&&t.closest?t.closest('[data-href]'):null;if(!a)return;var h=a.getAttribute('data-href');if(!h||h.charAt(0)==='#')return;e.preventDefault();try{parent.postMessage({__prudiiLink:h},'*');}catch(_){}},true);document.addEventListener('keydown',function(e){var t=e.target;var ed=!!(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable));var m=e.ctrlKey||e.metaKey,k=e.key.length===1?e.key.toLowerCase():e.key;var b=false;if(k==='F3'||k==='F5'||k==='F7'||k==='F12')b=true;else if(!m&&e.altKey&&(k==='ArrowLeft'||k==='ArrowRight'))b=!ed;else if(m&&!e.altKey){if(e.shiftKey&&(k==='i'||k==='j'||k==='c'))b=true;else if('rpfguhj+-=0'.indexOf(k)!==-1)b=true;}if(b)e.preventDefault();if(ed)return;try{parent.postMessage({__prudiiKey:{key:e.key,ctrlKey:e.ctrlKey,metaKey:e.metaKey,shiftKey:e.shiftKey,altKey:e.altKey}},'*');}catch(_){}},true);document.addEventListener('contextmenu',function(e){var t=e.target;if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable))return;e.preventDefault();var a=t&&t.closest?t.closest('[data-href]'):null;var h=a?a.getAttribute('data-href'):null;var img=t&&t.tagName==='IMG'?(t.currentSrc||t.src):null;var sel=String(window.getSelection?window.getSelection():'');var p={x:e.clientX,y:e.clientY};if(h&&h.charAt(0)!=='#')p.href=h;if(img)p.src=img;if(sel)p.selection=sel;if(!p.href&&!p.src&&!p.selection)return;try{parent.postMessage({__prudiiContextMenu:p},'*');}catch(_){}},true);})();`;

// SHA-256 of MAIL_LINK_BRIDGE (filled in by the regenerate command above).
export const MAIL_LINK_BRIDGE_CSP_HASH = "sha256-OdbYuxLwhcFcAtW9GGcX/D2/JKLX3dBcfQt9QhZbbAk=";

interface BridgedKey { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

// The iframe is its own document; shortcuts typed there would otherwise die at
// the frame boundary. Dispatching on the document (not window) makes the event
// path document -> window, so both document- and window-level handlers run.
export function relayBridgeKey(data: unknown, target: Window = window): boolean {
  const payload = (data as { __prudiiKey?: BridgedKey } | null)?.__prudiiKey;
  if (!payload || typeof payload.key !== "string") return false;
  target.document.dispatchEvent(new KeyboardEvent("keydown", { ...payload, bubbles: true, cancelable: true }));
  return true;
}

export interface BridgeContextMenu { x: number; y: number; href?: string; src?: string; selection?: string }

export function parseBridgeContextMenu(data: unknown): BridgeContextMenu | null {
  const p = (data as { __prudiiContextMenu?: Partial<BridgeContextMenu> } | null)?.__prudiiContextMenu;
  if (!p || typeof p.x !== "number" || typeof p.y !== "number") return null;
  const out: BridgeContextMenu = { x: p.x, y: p.y };
  if (typeof p.href === "string") out.href = p.href;
  if (typeof p.src === "string") out.src = p.src;
  if (typeof p.selection === "string" && p.selection) out.selection = p.selection;
  return out;
}
