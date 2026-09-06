import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolved from this file, not hardcoded: the absolute path here was one
// developer's machine and broke the moment the repo lived anywhere else.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.FOOVOX_URL;
const admin=readFileSync(`${ROOT}/data/admin-token.txt`,'utf8').trim();
const pair=await (await fetch(`${BASE}/api/auth/pair`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${admin}`},body:JSON.stringify({label:'model'})})).json();
const b=await puppeteer.launch({executablePath: process.env.CHROME_PATH ?? String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  headless:'new',args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required','--no-sandbox']});
const p=await b.newPage(); const errs=[];
p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await p.goto(`${BASE}/login?code=${encodeURIComponent(pair.code)}`,{waitUntil:'networkidle0'});
await Promise.all([p.waitForNavigation({waitUntil:'networkidle0'}),p.click('#go')]);
await p.waitForSelector('#model'); await new Promise(r=>setTimeout(r,1500));
console.log('starts on:', await p.$eval('#model',e=>e.value));
// ask something, then switch model mid-conversation and check memory survives
await p.evaluate(()=>window.foovox.ask('Remember the number 47. Just say ok.'));
await p.waitForFunction(()=>document.querySelectorAll('.msg.them').length>0,{timeout:60000});
await new Promise(r=>setTimeout(r,2000));
await p.evaluate(()=>{const m=document.getElementById('model'); m.value='claude-opus-5'; m.dispatchEvent(new Event('change'));});
await new Promise(r=>setTimeout(r,4000));
const sess=await p.evaluate(()=>window.foovox.state.session);
console.log('session now on:', sess.model, '| warm:', sess.warm);
await p.evaluate(()=>window.foovox.ask('What number did I ask you to remember?'));
await p.waitForFunction(()=>document.querySelectorAll('.msg.them').length>1,{timeout:60000});
await new Promise(r=>setTimeout(r,2500));
const reply=await p.evaluate(()=>[...document.querySelectorAll('.msg.them')].pop().textContent);
console.log('after switch, recalls:', reply.slice(0,90));
console.log('memory survived model switch:', /47/.test(reply) ? 'YES' : 'NO');
console.log('errors:', errs.length);
await b.close();
