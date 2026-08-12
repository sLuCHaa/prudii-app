// Runs inside the signature preview iframe. A parent-side listener on the
// iframe's contentDocument never fires on macOS/WKWebView (see MailDetail),
// so edits have to be relayed out with postMessage.
//
// The script is allow-listed by its SHA-256 hash in this iframe's CSP and in
// the parent CSP (tauri.conf.json); a `srcdoc` iframe inherits the parent CSP.
// If you change SIGNATURE_EDIT_BRIDGE, regenerate the hash:
//
//   node -e "const c=require('crypto');const m=require('fs').readFileSync('src/lib/signatureEditBridge.ts','utf8').match(/SIGNATURE_EDIT_BRIDGE = \`([\s\S]*?)\`;/)[1];console.log('sha256-'+c.createHash('sha256').update(m,'utf8').digest('base64'))"
//
export const SIGNATURE_EDIT_BRIDGE = `(function(){document.addEventListener('input',function(e){var t=e.target;if(!t||!t.getAttribute)return;var i=t.getAttribute('data-sig-text');if(i===null)return;try{parent.postMessage({__prudiiSigEdit:{index:Number(i),text:t.textContent||''}},'*');}catch(_){}},true);document.addEventListener('keydown',function(e){var t=e.target;if(!t||!t.getAttribute||t.getAttribute('data-sig-text')===null)return;if(e.key==='Enter'){e.preventDefault();}},true);})();`;

// SHA-256 of SIGNATURE_EDIT_BRIDGE (filled in by the regenerate command above).
export const SIGNATURE_EDIT_BRIDGE_CSP_HASH = "sha256-TXxKmjdlBr/Ifss8Da3ts62ucz6j5CWVJf3L00kcV8I=";
