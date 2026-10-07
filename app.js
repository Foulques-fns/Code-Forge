(function () {
  'use strict';
  const STORAGE = 'codeforge-static-projects-v3';
  const $ = (s) => document.querySelector(s);
  const home = $('#homeView'), workspace = $('#workspaceView');
  const request = $('#request'), projectList = $('#projectList'), toast = $('#toast');
  let current = null, currentPath = 'index.html';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  function notify(msg, error=false){ toast.textContent=msg; toast.className='toast show'+(error?' toast-error':''); clearTimeout(notify.t); notify.t=setTimeout(()=>toast.className='toast',3600); }
  function load(){ try { return JSON.parse(localStorage.getItem(STORAGE)||'[]'); } catch { return []; } }
  function persist(){ localStorage.setItem(STORAGE, JSON.stringify(load())); }
  function saveProjects(a){ localStorage.setItem(STORAGE, JSON.stringify(a)); renderProjects(); }
  function projectBytes(p){ return Object.values(p.files||{}).reduce((n,v)=>n+new Blob([v]).size,0); }
  function prettyBytes(n){ if(n<1024)return n+' o'; if(n<1048576)return (n/1024).toFixed(1)+' Ko'; return (n/1048576).toFixed(1)+' Mo'; }
  function renderProjects(){
    const a=load();
    if(!a.length){ projectList.innerHTML='<div class="glass empty">Aucun projet enregistré pour le moment.<br><span>Décrivez un projet ci-dessus pour commencer.</span></div>'; return; }
    projectList.innerHTML=a.map(p=>`<div class="glass project" data-id="${esc(p.id)}"><div class="project-main"><div class="project-name">${esc(p.name)}</div><div class="project-meta">${Object.keys(p.files||{}).length} fichiers · ${prettyBytes(projectBytes(p))} · ${new Date(p.updatedAt).toLocaleString('fr-FR')}</div></div><div class="project-actions"><span class="status"><span class="dot dot-ok"></span> prêt</span><button class="btn small open-project">Ouvrir</button><button class="icon-btn delete-project" title="Supprimer">×</button></div></div>`).join('');
    projectList.querySelectorAll('.open-project').forEach(b=>b.onclick=e=>openProject(e.currentTarget.closest('.project').dataset.id));
    projectList.querySelectorAll('.delete-project').forEach(b=>b.onclick=e=>{ const id=e.currentTarget.closest('.project').dataset.id; saveProjects(load().filter(p=>p.id!==id)); notify('Projet supprimé.'); });
  }

  function slugName(text){
    const first=text.trim().split(/[\n.!?]/)[0].replace(/^crée(?:r)?\s+/i,'').replace(/^fais(?:-moi)?\s+/i,'').trim();
    return (first || 'Nouveau projet').slice(0,64).replace(/\s+/g,' ');
  }
  function infer(title){
    const t=title.toLowerCase();
    const type = t.includes('portfolio')?'portfolio':t.includes('dashboard')||t.includes('admin')?'dashboard':t.includes('e-commerce')||t.includes('boutique')||t.includes('shop')?'shop':t.includes('blog')?'blog':t.includes('jeu')||t.includes('game')?'game':'website';
    return type;
  }
  function generateProject(description){
    const name=slugName(description), type=infer(description), safe=esc(description);
    const theme = type==='game' ? 'game' : type==='dashboard' ? 'dashboard' : type==='shop' ? 'shop' : 'site';
    const index=`<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${safe}</title>\n<meta name="description" content="Projet généré par CodeForge">\n<link rel="stylesheet" href="style.css">\n</head>\n<body data-theme="${theme}">\n<header class="nav"><a class="logo" href="#">${esc(name.split(' ').slice(0,2).join(' '))}</a><nav><a href="#features">Fonctionnalités</a><a href="#about">À propos</a><a href="#contact">Contact</a></nav><button class="nav-btn" id="themeBtn">☼</button></header>\n<main>\n<section class="hero"><div class="eyebrow">CODEFORGE · PROJET WEB</div><h1>${safe}</h1><p>Une expérience web construite à partir de votre description. Tout le code est local, éditable et exportable.</p><div class="hero-actions"><button class="primary" id="ctaBtn">Commencer</button><a class="secondary" href="#features">Découvrir ↓</a></div></section>\n<section id="features" class="section cards"><article><b>01</b><h2>Simple</h2><p>Une interface claire et responsive, sans dépendance serveur.</p></article><article><b>02</b><h2>Rapide</h2><p>HTML, CSS et JavaScript natifs pour un chargement immédiat.</p></article><article><b>03</b><h2>Modifiable</h2><p>Chaque fichier est visible et modifiable depuis CodeForge.</p></article></section>\n<section id="about" class="section about"><div><span class="eyebrow">VOTRE DEMANDE</span><h2>Un vrai point de départ.</h2></div><p>${safe}</p></section>\n<section id="contact" class="section contact"><h2>Prêt à continuer ?</h2><form id="contactForm"><input required placeholder="Votre email" type="email"><button class="primary">Envoyer</button></form><p id="formMsg" class="msg"></p></section>\n</main><footer>Généré localement avec CodeForge · GitHub Pages compatible</footer>\n<script src="script.js"></script>\n</body></html>`;
    const css=`*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:Inter,system-ui,sans-serif;background:#09090d;color:#f5f5f7;line-height:1.6}body:before{content:"";position:fixed;inset:0;z-index:-1;background:radial-gradient(circle at 80% 0%,#6557ff33,transparent 35%),radial-gradient(circle at 10% 70%,#36d9bd1c,transparent 30%)}.nav{height:72px;display:flex;align-items:center;justify-content:space-between;max-width:1120px;margin:auto;padding:0 24px;position:sticky;top:0;background:#09090dcc;backdrop-filter:blur(18px);z-index:5}.logo{font-weight:800;color:white;text-decoration:none;font-size:20px}.nav nav{display:flex;gap:26px}.nav nav a{color:#a9a9b6;text-decoration:none;font-size:14px}.nav nav a:hover{color:white}.nav-btn{background:#ffffff10;border:1px solid #ffffff18;color:white;border-radius:10px;padding:8px 12px;cursor:pointer}.hero{max-width:900px;margin:110px auto 0;text-align:center;padding:0 24px}.eyebrow{font-size:11px;letter-spacing:.16em;color:#63e5d0;font-weight:700}.hero h1{font-size:clamp(42px,8vw,82px);line-height:1.02;letter-spacing:-.055em;margin:18px 0}.hero p{max-width:650px;margin:0 auto;color:#aaaab7;font-size:17px}.hero-actions{display:flex;justify-content:center;gap:12px;margin-top:30px}.primary,.secondary{border-radius:12px;padding:12px 18px;font-weight:700;text-decoration:none;cursor:pointer}.primary{border:0;background:linear-gradient(120deg,#8b7cff,#5eead4);color:#08080d}.secondary{border:1px solid #ffffff20;color:white;background:#ffffff08}.section{max-width:1050px;margin:120px auto 0;padding:0 24px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.cards article{padding:28px;border:1px solid #ffffff10;background:#ffffff05;border-radius:20px}.cards b{color:#8b7cff}.cards h2{margin:18px 0 8px}.cards p,.about p{color:#aaaab7}.about{display:grid;grid-template-columns:1fr 1fr;gap:50px;padding:40px;border-radius:24px;background:#ffffff06;border:1px solid #ffffff10}.contact{text-align:center}.contact form{display:flex;max-width:560px;margin:24px auto;gap:10px}.contact input{flex:1;background:#ffffff08;border:1px solid #ffffff16;color:white;padding:13px;border-radius:10px}.msg{color:#63e5d0}.light{background:#f4f4f7;color:#111}.light .nav{background:#f4f4f7dd}.light .nav a,.light .nav nav a{color:#444}.light .cards article,.light .about{background:#00000005;border-color:#00000012}.light .hero p,.light .cards p,.light .about p{color:#555}.light .secondary{color:#111;border-color:#0002}footer{text-align:center;color:#666;margin:100px 0 30px;font-size:12px}@media(max-width:700px){.nav nav{display:none}.cards,.about{grid-template-columns:1fr}.hero{margin-top:70px}.contact form{flex-direction:column}}`;
    const js=`document.addEventListener('DOMContentLoaded',()=>{const theme=document.querySelector('#themeBtn');theme?.addEventListener('click',()=>document.body.classList.toggle('light'));document.querySelector('#ctaBtn')?.addEventListener('click',()=>document.querySelector('#contact')?.scrollIntoView({behavior:'smooth'}));document.querySelector('#contactForm')?.addEventListener('submit',e=>{e.preventDefault();document.querySelector('#formMsg').textContent='Message enregistré localement — formulaire de démonstration.';e.currentTarget.reset()})});`;
    const readme=`# ${name}\n\nProjet généré avec CodeForge.\n\n## Lancer\nOuvrez simplement index.html dans un navigateur.\n\n## GitHub Pages\nPlacez le contenu de ce dossier à la racine d'un dépôt GitHub puis activez GitHub Pages depuis Settings → Pages → Deploy from branch.\n\n## Description\n${description}\n`;
    return {id:uid(),name,description,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),files:{'index.html':index,'style.css':css,'script.js':js,'README.md':readme}};
  }

  async function tryOllama(description){
    try{
      const base='http://127.0.0.1:11434';
      const tags=await fetch(base+'/api/tags',{signal:AbortSignal.timeout(1000)}).then(r=>r.ok?r.json():null);
      const model=(tags?.models||[]).find(m=>/coder|qwen|deepseek|llama|mistral/i.test(m.name||''))?.name || tags?.models?.[0]?.name;
      if(!model) return null;
      const prompt=`Tu es un générateur web. Retourne UNIQUEMENT un JSON valide avec exactement les clés index.html, style.css, script.js. Génère un petit site réellement fonctionnel, autonome, sans backend, à partir de cette demande : ${description}`;
      const res=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],stream:false,options:{temperature:.2}}),signal:AbortSignal.timeout(90000)});
      const data=await res.json(), raw=data?.message?.content||'';
      const match=raw.match(/\{[\s\S]*\}/); if(!match)return null;
      const out=JSON.parse(match[0]); if(typeof out['index.html']!=='string'||typeof out['style.css']!=='string'||typeof out['script.js']!=='string')return null;
      return out;
    }catch{return null}
  }

  async function forge(){
    const text=request.value.trim(); if(text.length<4){notify('Décrivez un peu plus votre projet.',true);request.focus();return;}
    $('#forgeBtn').disabled=true; $('#forgeBtn').textContent='⟳ Génération…'; $('#homeError').classList.add('hidden');
    let p=generateProject(text); const ai=await tryOllama(text);
    if(ai){p.files['index.html']=ai['index.html'];p.files['style.css']=ai['style.css'];p.files['script.js']=ai['script.js'];p.ai=true;$('#engineDot').className='dot dot-ok';$('#engineLabel').textContent='Ollama local';}
    else {$('#engineDot').className='dot dot-idle';$('#engineLabel').textContent='mode local';}
    const a=load();a.unshift(p);saveProjects(a.slice(0,30));request.value='';openProject(p.id);notify(ai?'Projet généré par le moteur local.':'Projet généré localement.');
    $('#forgeBtn').disabled=false;$('#forgeBtn').textContent='➜ Forger le projet';
  }

  function openProject(id){ current=load().find(p=>p.id===id); if(!current)return; home.classList.add('hidden');workspace.classList.remove('hidden'); currentPath=Object.keys(current.files)[0]||'index.html'; renderWorkspace(); selectFile(currentPath); refreshPreview(); }
  function renderWorkspace(){ $('#workspaceName').textContent=current.name;$('#projectDescription').textContent=current.description;$('#fileCount').textContent=Object.keys(current.files).length+' fichiers';$('#projectSize').textContent=prettyBytes(projectBytes(current)); const tree=$('#fileTree');tree.innerHTML=Object.keys(current.files).sort().map(p=>`<button class="tree-item ${p===currentPath?'active':''}" data-path="${esc(p)}"><span>${fileIcon(p)}</span>${esc(p)}</button>`).join('');tree.querySelectorAll('.tree-item').forEach(b=>b.onclick=()=>selectFile(b.dataset.path)); }
  function fileIcon(p){if(/\.html?$/i.test(p))return'◉';if(/\.css$/i.test(p))return'◈';if(/\.js$/i.test(p))return'◇';if(/\.md$/i.test(p))return'▤';return'•';}
  function selectFile(path){currentPath=path;$('#currentFile').textContent=path;$('#currentLang').textContent=(path.split('.').pop()||'TEXT').toUpperCase();$('#codeEditor').value=current.files[path]??'';renderWorkspace();}
  function saveFile(){current.files[currentPath]=$('#codeEditor').value;current.updatedAt=new Date().toISOString();const a=load().map(p=>p.id===current.id?current:p);saveProjects(a);refreshPreview();notify('Fichier enregistré.');}
  function refreshPreview(){const html=current?.files?.['index.html'];if(!html){$('#previewFrame').srcdoc='<p style="font-family:sans-serif;padding:20px">Aucun index.html</p>';return}let doc=html.replace(/<link\s+[^>]*href=["']style\.css["'][^>]*>/i,`<style>${current.files['style.css']||''}</style>`).replace(/<script\s+[^>]*src=["']script\.js["'][^>]*><\/script>/i,`<script>${current.files['script.js']||''}<\/script>`);$('#previewFrame').srcdoc=doc;}
  function downloadProject(){if(!window.JSZip){notify('Le module ZIP est indisponible. Rechargez la page.',true);return}const zip=new JSZip();Object.entries(current.files).forEach(([p,c])=>zip.file(p,c));zip.generateAsync({type:'blob',compression:'DEFLATE'}).then(blob=>{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=(current.name||'codeforge-project').replace(/[^a-z0-9_-]+/gi,'-').toLowerCase()+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);notify('ZIP téléchargé.');});}
  async function importZip(file){if(!window.JSZip){notify('Impossible de charger le module ZIP.',true);return}try{const zip=await JSZip.loadAsync(file),files={};for(const name of Object.keys(zip.files)){const e=zip.files[name];if(e.dir||/(^|\/)(node_modules|\.git|\.next|dist|build|coverage)(\/|$)/i.test(name))continue;if(/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip|mp4|mov)$/i.test(name))continue;if(Object.keys(files).length>=200)break;files[name]=await e.async('string');}const index=Object.keys(files).find(p=>p==='index.html')||Object.keys(files).find(p=>/\/index\.html$/i.test(p));if(!index)throw new Error('Le ZIP ne contient pas de page index.html.');const root=index==='index.html'?'':index.replace(/index\.html$/,'');const normalized={};Object.entries(files).forEach(([p,c])=>normalized[root&&p.startsWith(root)?p.slice(root.length):p]=c);const p={id:uid(),name:file.name.replace(/\.zip$/i,''),description:'Projet importé depuis '+file.name,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),files:normalized};const a=load();a.unshift(p);saveProjects(a.slice(0,30));openProject(p.id);notify('ZIP importé avec succès.');}catch(e){notify(e.message||'Import ZIP impossible.',true);}}

  $('#forgeBtn').onclick=forge;request.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();forge();}});
  $('#clearBtn').onclick=()=>{if(confirm('Effacer tous les projets locaux ?')){localStorage.removeItem(STORAGE);renderProjects();notify('Projets effacés.');}};
  $('#backBtn').onclick=()=>{workspace.classList.add('hidden');home.classList.remove('hidden');renderProjects();};
  $('#saveFileBtn').onclick=saveFile;$('#refreshPreviewBtn').onclick=refreshPreview;$('#previewBtn').onclick=()=>{refreshPreview();document.querySelector('.preview-panel').scrollIntoView({behavior:'smooth'});};$('#downloadBtn').onclick=downloadProject;
  $('#importBtn').onclick=()=>$('#zipInput').click();$('#zipInput').onchange=e=>{const f=e.target.files[0];if(f)importZip(f);e.target.value='';};
  $('#newFileBtn').onclick=()=>{const name=prompt('Nom du fichier (ex: about.html)');if(!name||current.files[name])return;current.files[name]='';current.updatedAt=new Date().toISOString();saveProjects(load().map(p=>p.id===current.id?current:p));selectFile(name);notify('Nouveau fichier créé.');};
  $('#codeEditor').addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const t=e.currentTarget,s=t.selectionStart;t.setRangeText('  ',s,t.selectionEnd,'end');}});
  renderProjects();
})();
