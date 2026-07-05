// In-frame click bridge injected into the sandboxed email iframe.
//
// WKWebView (macOS) does not deliver click events to a listener the parent
// attaches on the iframe's contentDocument, so the click must be handled from
// INSIDE the frame and the target relayed to the parent via postMessage. The
// parent then opens the link with the opener plugin. Works on both WKWebView
// and WebView2.
//
// IMPORTANT — CSP: a `srcdoc` iframe inherits the parent document's CSP. The
// production CSP in `apps/desktop/src-tauri/tauri.conf.json` pins `script-src`,
// so this exact script is allow-listed there by its SHA-256 hash
// (MAIL_LINK_BRIDGE_CSP_HASH). If you change MAIL_LINK_BRIDGE, regenerate the
// hash and update BOTH this constant AND the `script-src` entry in
// tauri.conf.json, or links will silently stop opening in production builds
// (dev does not enforce the CSP, so it would still appear to work there).
//
// Regenerate the hash:
//   node -e "const c=require('crypto');const m=require('fs').readFileSync('apps/desktop/src/lib/mailLinkBridge.ts','utf8').match(/MAIL_LINK_BRIDGE = \`([\s\S]*?)\`;/)[1];console.log('sha256-'+c.createHash('sha256').update(m,'utf8').digest('base64'))"

export const MAIL_LINK_BRIDGE = `(function(){document.addEventListener('click',function(e){var t=e.target;if(t&&t.tagName==='IMG'&&(!t.closest||!t.closest('a'))){var s=t.currentSrc||t.src;if(s){e.preventDefault();try{parent.postMessage({__prudiiImage:s},'*');}catch(_){}}return;}var a=t&&t.closest?t.closest('[data-href]'):null;if(!a)return;var h=a.getAttribute('data-href');if(!h||h.charAt(0)==='#')return;e.preventDefault();try{parent.postMessage({__prudiiLink:h},'*');}catch(_){}},true);})();`;

// SHA-256 of MAIL_LINK_BRIDGE (filled in by the regenerate command above).
export const MAIL_LINK_BRIDGE_CSP_HASH = "sha256-lo44IaNMj8n102MDbFbLK+h3Td+693IksT6jAzsGPFI=";
