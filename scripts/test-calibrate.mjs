import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolved from this file, not hardcoded: the absolute path here was one
// developer's machine and broke the moment the repo lived anywhere else.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE=process.env.FOOVOX_URL;
const admin=readFileSync(`${ROOT}/data/admin-token.txt`,'utf8').trim();
const pair=await (await fetch(`${BASE}/api/auth/pair`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${admin}`},body:JSON.stringify({label:'calib'})})).json();
const b=await puppeteer.launch({executablePath: process.env.CHROME_PATH ?? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,headless:'new',
  args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required','--no-sandbox']});
const p=await b.newPage(); await p.setViewport({width:414,height:896,deviceScaleFactor:2});
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await p.goto(`${BASE}/login?code=${encodeURIComponent(pair.code)}`,{waitUntil:'networkidle0'});
await Promise.all([p.waitForNavigation({waitUntil:'networkidle0'}),p.click('#go')]);
await p.waitForSelector('#mic'); await new Promise(r=>setTimeout(r,1200));
await p.evaluate(()=>document.getElementById('mic').click());
await new Promise(r=>setTimeout(r,1500));
console.log('meter width before:', await p.$eval('#meter-fill',e=>e.style.width));
console.log('meter dB:', await p.$eval('#meter-db',e=>e.textContent));
// calibrate
await p.evaluate(()=>document.getElementById('calibrate').click());
await new Promise(r=>setTimeout(r,4000));
const after=await p.evaluate(()=>({
  noiseFloor: window.foovox.state.settings.noiseFloor,
  sens: window.foovox.state.settings.sensitivity,
  btn: document.getElementById('calibrate').textContent,
  note: [...document.querySelectorAll('.msg.note')].map(e=>e.textContent).pop(),
  saved: JSON.parse(localStorage.getItem('foovox')||'{}').noiseFloor,
}));
console.log('calibrated noiseFloor:', after.noiseFloor?.toFixed(4), '| persisted:', after.saved?.toFixed(4));
console.log('button reset to:', after.btn);
console.log('note:', after.note);
// sensitivity slider
await p.evaluate(()=>{const s=document.getElementById('sens'); s.value='5.5'; s.dispatchEvent(new Event('input'));});
console.log('sens after slider:', await p.evaluate(()=>window.foovox.state.settings.sensitivity), await p.$eval('#sens-value',e=>e.textContent));
await p.screenshot({path:`${ROOT}/shot-meter.png`});
console.log('errors:', errs.length, errs.slice(0,3).join(' | '));
await b.close();
