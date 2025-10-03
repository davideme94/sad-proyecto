"use strict";

let TOKEN = null;
const $ = (id) => document.getElementById(id);
const toggle = (el, visible, display = "") => (el && (el.style.display = visible ? display : "none"));
const saveToken = (t) => (TOKEN = t, t ? localStorage.setItem("TOKEN", t) : localStorage.removeItem("TOKEN"));

// Misma-origin: rutas relativas (no hace falta api-base)
const api = (p) => p;

function toast(msg, type = "ok") {
  const wrap = $("toasts"); if (!wrap) return alert(msg);
  const div = document.createElement("div");
  div.className = `toast ${type}`; div.textContent = msg; wrap.appendChild(div);
  setTimeout(() => { div.style.opacity = "0"; div.style.transform = "translateY(-6px)"; setTimeout(() => wrap.removeChild(div), 300); }, 2200);
}

function setAuthUI(email) {
  const badge = $("authBadge");
  if (badge) badge.textContent = email ? "Conectado" : "No conectado";
  toggle($("btnLogout"), !!email);
  toggle($("adminPanel"), !!email);
}

const debounce = (fn, ms=250) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };

// Utilidad: fetch con timeout y manejo de errores
async function httpJson(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal, headers: { Accept: "application/json", ...(opts.headers || {}) } });
    clearTimeout(id);
    if (!res.ok) {
      let msg = `Error ${res.status}`;
      try {
        const data = await res.json();
        if (data?.error) msg = data.error;
      } catch {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    clearTimeout(id);
    if (e.name === "AbortError") throw new Error("Tiempo de espera agotado");
    throw e;
  }
}

// ---------- Público: registrar y descargar ----------
window.registrarYDescargar = async function (dni, resolucionId) {
  const nom = $(`nom_${resolucionId}`)?.value.trim();
  const email = $(`mail_${resolucionId}`)?.value.trim();
  const acepto = $(`chk_${resolucionId}`)?.checked;
  if (!nom || !email || !acepto) return toast("Completá nombre, email y aceptación", "err");
  const textoLegal = "La sola descarga del archivo dará por cumplida la notificación.";
  try {
    const data = await httpJson(api(`/api/public/acuse`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docenteDni: dni, resolucionId, nombreCompleto: nom, email, acepto: true, textoLegal })
    });
    if (data.ok && data.driveUrl) {
      window.open(data.driveUrl, "_blank", "noopener"); toast("Descargo registrado ✅");
    } else {
      toast(data.error || "Error al registrar", "err");
    }
  } catch (e) {
    toast(e.message || "Error de red", "err");
  }
};

// descarga directa (si yaAcuso)
window.descargarDirecto = function (url) {
  window.open(url, "_blank", "noopener");
};

// ===============================
// CARGA MASIVA: estado y helpers
// ===============================
let BULK_ROWS = []; // { nombre, dni, ok, reason }

function normName(s) {
  if (!s) return "";
  // colapsar espacios, quitar tabulaciones, trim
  return s.replace(/\s+/g, " ").replace(/\t/g, " ").trim();
}

function normDni(s) {
  if (!s) return "";
  const digits = String(s).replace(/\D+/g, ""); // solo dígitos
  return digits; // validación afuera (7-9 dígitos)
}

function parseBulkInputs() {
  const rawNames = $("bulkNombres")?.value || "";
  const rawDnis = $("bulkDnis")?.value || "";

  // separar por líneas, también admite pegar columnas: tratamos \r\n y \n
  const names = rawNames.split(/\r?\n/).map(normName).filter(x => x.length > 0);
  const dnis = rawDnis.split(/\r?\n/).map(normDni).filter(x => x.length > 0);

  const max = Math.max(names.length, dnis.length);
  const rows = [];

  for (let i = 0; i < max; i++) {
    const nombre = normName(names[i] || "");
    const dni = normDni(dnis[i] || "");
    let ok = true, reason = "";

    if (!nombre) { ok = false; reason = "Nombre vacío"; }
    if (!/^[0-9]{7,9}$/.test(dni)) { ok = false; reason = reason ? (reason + " + DNI inválido") : "DNI inválido"; }

    rows.push({ nombre, dni, ok, reason });
  }
  return rows;
}

function renderBulkTable() {
  const tbody = $("bulkTbody"); if (!tbody) return;
  const count = $("bulkCount");

  tbody.innerHTML = BULK_ROWS.map((r, idx) => `
    <tr class="${r.ok ? "" : "danger-row"}">
      <td style="text-align:center">${idx + 1}</td>
      <td>${r.nombre || "<i>—</i>"}</td>
      <td><code>${r.dni || "—"}</code></td>
      <td>${r.ok ? "<span class='ok'>OK</span>" : `<span class='danger'>${r.reason}</span>`}</td>
      <td style="text-align:right">
        <button class="btn-plain" onclick="rmBulk(${idx})">Quitar</button>
      </td>
    </tr>
  `).join("");

  const valid = BULK_ROWS.filter(r => r.ok).length;
  const invalid = BULK_ROWS.length - valid;
  if (count) count.textContent = `Filas: ${BULK_ROWS.length} • Válidas: ${valid} • Inválidas: ${invalid}`;
}

window.rmBulk = (idx) => {
  BULK_ROWS.splice(idx, 1);
  renderBulkTable();
};

async function bulkGuardar() {
  const valid = BULK_ROWS.filter(r => r.ok).map(r => ({ dni: r.dni, nombre: r.nombre }));
  if (!valid.length) return toast("No hay filas válidas para guardar", "err");

  // Intento 1: endpoint bulk
  try {
    const res = await httpJson(api(`/api/admin/docentes/bulk`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`
      },
      body: JSON.stringify({ items: valid })
    }, 60000);
    // esperamos algo como { ok:true, upserted: n, updated: m, errors: [...] }
    if (res?.ok) {
      toast(`Guardados: ${res.upserted ?? valid.length} (algunos pueden haberse actualizado) ✅`);
      BULK_ROWS = [];
      renderBulkTable();
      return;
    }
    // si no devuelve ok, continúo al fallback
    throw new Error(res?.error || "bulk no disponible");
  } catch (e) {
    // Fallback: guardar uno por uno
    let okCount = 0, errCount = 0;
    for (const it of valid) {
      try {
        await httpJson(api(`/api/admin/docentes`), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization:`Bearer ${TOKEN}` },
          body: JSON.stringify(it)
        }, 30000);
        okCount++;
      } catch {
        errCount++;
      }
    }
    toast(`Bulk (fallback): OK ${okCount} • Errores ${errCount}`, errCount ? "err" : "ok");
    BULK_ROWS = [];
    renderBulkTable();
  }
}

// ===============================

window.addEventListener("DOMContentLoaded", () => {
  // ------- Buscar por DNI -------
  $("btnBuscar")?.addEventListener("click", async () => {
    const dni = $("dni")?.value.trim(); const out = $("resultado"); if (!out) return;
    if (!/^[0-9]{7,9}$/.test(dni || "")) { out.innerHTML = '<p class="danger">DNI inválido</p>'; return; }
    out.innerHTML = '<p class="muted">Buscando…</p>';
    try {
      const data = await httpJson(api(`/api/public/buscar?dni=${encodeURIComponent(dni)}`));
      const nombre = data.nombre ? `Nombre: <b>${data.nombre}</b>` : '<span class="danger">No se encontró ninguna persona con ese DNI</span>';
      if (!data.resoluciones?.length) { out.innerHTML = `<p>${nombre}</p>`; return; }
      out.innerHTML = `
        <p>${nombre}</p>
        ${data.resoluciones.map(r => `
          <div class="list-item">
            <div><b>${r.titulo}</b></div>
            <div class="muted">${[r.expediente, r.nivel].filter(Boolean).join(' • ')}</div>
            <div class="field">
              ${
                r.yaAcuso
                  ? `
                    <button onclick="descargarDirecto('${r.driveUrl}')">Descargar</button>
                    <span class="ok" style="margin-left:8px">Acuse registrado ✓</span>
                  `
                  : `
                    <input id="nom_${r._id}" placeholder="Nombre y Apellido" />
                    <input id="mail_${r._id}" placeholder="Correo electrónico" />
                    <label style="font-size:14px">
                      <input type="checkbox" id="chk_${r._id}">
                      Acepto: “La sola descarga del archivo dará por cumplida la notificación.”
                    </label>
                    <button onclick="registrarYDescargar('${data.dni}','${r._id}')">Descargar</button>
                  `
              }
            </div>
          </div>`).join('')}
      `;
    } catch (e) {
      out.innerHTML = `<p class="danger">${e.message || "Error al buscar. Intente nuevamente."}</p>`;
    }
  });

  // ------- Login -------
  const modal = $("loginModal"), emailIn = $("loginEmail"), passIn = $("loginPass"), errorBox = $("loginError");
  $("btnLogin")?.addEventListener("click", () => { if(!modal) return; errorBox.textContent=""; toggle(errorBox,false); if (emailIn) emailIn.value=""; if (passIn) passIn.value=""; toggle(modal,true,"flex"); setTimeout(()=>emailIn?.focus(),0); });
  $("btnLoginCancel")?.addEventListener("click", () => toggle(modal, false));
  modal?.addEventListener("click", (e) => { if (e.target === modal) toggle(modal, false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggle(modal, false); });
  $("btnLoginSubmit")?.addEventListener("click", async () => {
    const email = emailIn?.value.trim(), password = passIn?.value;
    if (!email || !password) { errorBox.textContent="Completá email y contraseña"; toggle(errorBox,true); return; }
    try {
      const data = await httpJson(api(`/api/auth/login`), { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ email, password }) });
      if (data.token) { saveToken(data.token); setAuthUI(data.email || "administrador"); toggle(modal,false); toast("Sesión iniciada ✅"); }
      else { errorBox.textContent = data.error || "Credenciales inválidas"; toggle(errorBox, true); }
    } catch (e) { errorBox.textContent = e.message || "Error de red"; toggle(errorBox, true); }
  });
  $("btnLogout")?.addEventListener("click", () => { saveToken(null); setAuthUI(null); toast("Sesión cerrada"); });

 // ------- Admin: Docentes (individual) -------
$("btnGuardarDoc")?.addEventListener("click", async () => {
  // Sanitizar antes de validar
  const dniInput = $("docDni")?.value ?? "";
  const nombreInput = $("docNombre")?.value ?? "";

  // DNI solo dígitos (sin puntos, espacios, guiones, etc.)
  const dni = dniInput.replace(/\D+/g, "");
  // Nombre con espacios colapsados y sin bordes
  const nombre = nombreInput.replace(/\s+/g, " ").trim();

  if (!/^[0-9]{7,9}$/.test(dni) || !nombre) {
    return toast("Datos inválidos (DNI 7–9 dígitos y nombre no vacío)", "err");
  }

  try {
    const data = await httpJson(api(`/api/admin/docentes`), {
      method:"POST",
      headers:{ "Content-Type":"application/json", Authorization:`Bearer ${TOKEN}` },
      body: JSON.stringify({ dni, nombre })
    });
    const s = $("statusDoc");
    if (data.alreadyExisted) { s.textContent="Ya creado"; s.className="ok"; toast("Docente ya existía ✅"); return; }
    if (data.updated)      { s.textContent="Actualizado"; s.className="ok"; toast("Docente actualizado ✅"); return; }
    if (data.created)      { s.textContent="Creado";     s.className="ok"; toast("Docente creado ✅"); return; }
    if (data._id)          { s.textContent="Guardado";   s.className="ok"; toast("Docente guardado ✅"); return; }
    s.textContent = data.error || "Error"; s.className="danger"; toast(data.error || "Error", "err");
  } catch (e) {
    toast(e.message || "Error", "err");
  }
});

$("btnListDoc")?.addEventListener("click", async () => {
  const q = prompt("Buscar (opcional: nombre o DNI):", "") || "";
  const list = await httpJson(api(`/api/admin/docentes?q=${encodeURIComponent(q)}`), { headers:{ Authorization:`Bearer ${TOKEN}` }});
  const c = $("adminLista"); if (!c) return;
  c.innerHTML = `<h4>Docentes (${list.length})</h4>` + list.map(d => `
    <div class="list-item">
      <b>${d.nombre}</b> — DNI <code>${d.dni}</code>
      <div class="actions" style="margin-top:6px">
        <button class="btn-plain" onclick="editarDoc('${d.dni}','${d.nombre.replace(/'/g,"&#39;")}')">Editar</button>
        <button style="background:#e53e3e" onclick="borrarDoc('${d.dni}')">Borrar</button>
      </div>
    </div>
  `).join("");
});

  window.editarDoc = (dni,nombre)=>{ const dn = $("docDni"), nm = $("docNombre"); if(dn) dn.value=dni; if(nm) nm.value=nombre; };
  window.borrarDoc = async (dni)=>{ if(!confirm(`Borrar docente DNI ${dni}?`))return;
    const data = await httpJson(api(`/api/admin/docentes/${dni}`), { method:"DELETE", headers:{ Authorization:`Bearer ${TOKEN}` }});
    if (data.ok) { toast("Docente borrado ✅"); $("btnListDoc").click(); } else toast(data.error||"Error","err"); };

  // ------- Admin: Resoluciones -------
  $("btnCrearRes")?.addEventListener("click", async () => {
    const titulo = $("titulo")?.value.trim(), driveUrl = $("driveUrl")?.value.trim();
    const expediente = $("expediente")?.value.trim() || null; const nivel = $("nivel")?.value || null;
    if (!titulo || !driveUrl) return toast("Completá título y URL", "err");
    try {
      const data = await httpJson(api(`/api/admin/resoluciones`), { method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${TOKEN}` }, body: JSON.stringify({ titulo, driveUrl, expediente, nivel }) });
      const s = $("statusRes");
      if (data.alreadyExisted) { s.textContent="Ya creada"; s.className="ok"; toast("Resolución ya existía ✅"); return; }
      if (data.created || data._id) { s.textContent="Creada"; s.className="ok"; toast("Resolución creada ✅"); return; }
      s.textContent = data.error || "Error"; s.className="danger"; toast(data.error || "Error", "err");
    } catch (e) { toast(e.message || "Error", "err"); }
  });

  $("btnListRes")?.addEventListener("click", async () => {
    const q = prompt("Buscar (opcional: título):", "") || "";
    const list = await httpJson(api(`/api/admin/resoluciones?q=${encodeURIComponent(q)}`), { headers:{ Authorization:`Bearer ${TOKEN}` }});
    const c = $("adminLista"); if (!c) return;
    c.innerHTML = `<h4>Resoluciones (${list.length})</h4>` + list.map(r => `
      <div class="list-item">
        <div><b>${r.titulo}</b></div>
        <div class="muted">${[r.expediente, r.nivel, r.driveUrl].filter(Boolean).join(' • ')}</div>
        <div class="actions" style="margin-top:6px">
          <button class="btn-plain" onclick="prefillRes('${r._id}','${String(r.titulo).replace(/'/g,"&#39;")}','${String(r.driveUrl).replace(/'/g,"&#39;")}','${r.expediente?String(r.expediente).replace(/'/g,"&#39;"):""}','${r.nivel??""}')">Editar</button>
          <button class="btn-plain" onclick="verVinculos('${r._id}')">Vínculos</button>
          <button style="background:#e53e3e" onclick="borrarRes('${r._id}')">Borrar</button>
        </div>
      </div>
    `).join("");
  });
  window.prefillRes = (id,titulo,driveUrl,expediente,nivel)=>{ const t=$("titulo"), d=$("driveUrl"), e=$("expediente"), n=$("nivel"), b=$("resBuscar"); if(t)t.value=titulo; if(d)d.value=driveUrl; if(e)e.value=expediente||""; if(n)n.value=nivel||""; if(b)b.value=titulo; setResSeleccion(id,titulo); toast("Formulario cargado para editar/vincular"); };
  window.borrarRes = async (id)=>{ if(!confirm("¿Borrar resolución y sus vínculos?"))return;
    const data = await httpJson(api(`/api/admin/resoluciones/${id}`), { method:"DELETE", headers:{ Authorization:`Bearer ${TOKEN}` }});
    if (data.ok) { toast("Resolución borrada ✅"); $("btnListRes").click(); } else toast(data.error||"Error","err"); };

  // ===============================
  // Autocompletar: Resolución
  // ===============================
  let RES_CACHE = [];
  async function ensureResCache() {
    if (RES_CACHE.length) return;
    RES_CACHE = await httpJson(api(`/api/admin/resoluciones`), { headers:{ Authorization:`Bearer ${TOKEN}` }});
  }
  const resSug = $("resSug"), resBuscar = $("resBuscar"), resSel = $("resSel");
  function setResSeleccion(id, titulo) {
    if (!resSel) return;
    resSel.textContent = titulo; resSel.style.display = ""; resSel.dataset.id = id;
    const x = document.createElement("button"); x.textContent = "✕";
    x.onclick = ()=>{ resSel.style.display="none"; resSel.dataset.id=""; if(resBuscar) resBuscar.value=""; };
    resSel.appendChild(x);
  }
  function resRenderSugs(list){
    if (!resSug) return;
    resSug.innerHTML = list.map((r,i) => `<div class="sugs-item" data-idx="${i}" data-id="${r._id}">${r.titulo}</div>`).join("");
    toggle(resSug, list.length>0, "");
  }
  let RES_VIEW = [];
  let resActive = -1;

  const debounceFn = (fn, ms=200) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; };

  resBuscar?.addEventListener("input", debounceFn(async () => {
    await ensureResCache();
    const q = (resBuscar.value || "").toLowerCase().trim();
    RES_VIEW = RES_CACHE.filter(r => r.titulo.toLowerCase().includes(q)).slice(0, 10);
    resActive = -1;
    resRenderSugs(RES_VIEW);
  }));

  function resSetActive(newIdx){
    const items = resSug?.querySelectorAll(".sugs-item") || [];
    items.forEach(el => el.classList.remove("active"));
    if (newIdx >= 0 && newIdx < items.length) {
      items[newIdx].classList.add("active");
      items[newIdx].scrollIntoView({ block:"nearest" });
    }
  }
  function resSelectByIndex(idx){
    if (idx < 0 || idx >= RES_VIEW.length) return;
    const r = RES_VIEW[idx];
    setResSeleccion(r._id, r.titulo);
    if (resBuscar) resBuscar.value = r.titulo;
    toggle(resSug, false);
  }
  resBuscar?.addEventListener("keydown", (e)=>{
    const max = RES_VIEW.length;
    if (!["ArrowDown","ArrowUp","Enter","Escape"].includes(e.key)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault(); if (!max) return;
      resActive = (resActive + 1) % max; resSetActive(resActive);
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); if (!max) return;
      resActive = (resActive - 1 + max) % max; resSetActive(resActive);
    } else if (e.key === "Enter") {
      e.preventDefault(); if (resActive >= 0) resSelectByIndex(resActive);
    } else if (e.key === "Escape") {
      toggle(resSug, false);
    }
  });
  resSug?.addEventListener("click", (e)=>{
    const item = e.target.closest(".sugs-item"); if(!item) return;
    const idx = Number(item.dataset.idx);
    resSelectByIndex(idx);
  });

  // ===============================
  // Autocompletar: Docentes
  // ===============================
  const docSug = $("docSug"), docBuscar = $("docBuscar"), docSel = $("docSel");
  let DOC_TIMER=null;
  const chipFor = (dni,nombre)=>`<span class="chip" data-dni="${dni}">${nombre} — ${dni} <button onclick="rmChip('${dni}')">✕</button></span>`;
  window.rmChip = (dni)=>{ const el = docSel?.querySelector(`.chip[data-dni="${dni}"]`); if(el) el.remove(); };

  let DOC_VIEW = [];
  let docActive = -1;

  function docRenderSugs(list){
    if (!docSug) return;
    docSug.innerHTML = list.map((d,i) =>
      `<div class="sugs-item" data-idx="${i}" data-dni="${d.dni}" data-nombre="${d.nombre.replace(/"/g,"&quot;")}"><b>${d.dni}</b> — ${d.nombre}</div>`
    ).join("");
    toggle(docSug, list.length>0, "");
  }
  function docSetActive(newIdx){
    const items = docSug?.querySelectorAll(".sugs-item") || [];
    items.forEach(el => el.classList.remove("active"));
    if (newIdx >= 0 && newIdx < items.length) {
      items[newIdx].classList.add("active");
      items[newIdx].scrollIntoView({ block:"nearest" });
    }
  }
  function docAddByIndex(idx){
    if (idx < 0 || idx >= DOC_VIEW.length) return;
    const d = DOC_VIEW[idx];
    if (!docSel?.querySelector(`.chip[data-dni="${d.dni}"]`)) {
      docSel?.insertAdjacentHTML("beforeend", chipFor(d.dni, d.nombre));
    }
    toggle(docSug,false); if (docBuscar) docBuscar.value="";
    docActive=-1;
  }

  docBuscar?.addEventListener("input", ()=>{
    clearTimeout(DOC_TIMER);
    DOC_TIMER = setTimeout(async ()=>{
      const q = (docBuscar.value||"").trim(); if (!q) { toggle(docSug,false); DOC_VIEW=[]; docActive=-1; return; }
      DOC_VIEW = await httpJson(api(`/api/admin/docentes?q=${encodeURIComponent(q)}`), { headers:{ Authorization:`Bearer ${TOKEN}` }});
      DOC_VIEW = DOC_VIEW.slice(0,10);
      docActive = -1;
      docRenderSugs(DOC_VIEW);
    }, 200);
  });

  docBuscar?.addEventListener("keydown", (e)=>{
    if (!["ArrowDown","ArrowUp","Enter","Escape"].includes(e.key)) return;
    const max = DOC_VIEW.length;
    if (e.key === "ArrowDown") {
      e.preventDefault(); if (!max) return;
      docActive = (docActive + 1) % max; docSetActive(docActive);
    } else if (e.key === "ArrowUp") {
      e.preventDefault(); if (!max) return;
      docActive = (docActive - 1 + max) % max; docSetActive(docActive);
    } else if (e.key === "Enter") {
      e.preventDefault(); if (docActive >= 0) docAddByIndex(docActive);
    } else if (e.key === "Escape") {
      toggle(docSug, false);
    }
  });

  docSug?.addEventListener("click", (e)=>{
    const item = e.target.closest(".sugs-item"); if(!item) return;
    const idx = Number(item.dataset.idx);
    docAddByIndex(idx);
  });

  // ------- Vincular -------
  $("btnVincular")?.addEventListener("click", async ()=>{
    const resolucionId = $("resSel")?.dataset.id || "";
    const dnis = Array.from($("docSel")?.querySelectorAll(".chip") || []).map(x=>x.dataset.dni);
    if (!resolucionId) return toast("Elegí una resolución", "err");
    if (!dnis.length) return toast("Agregá al menos un docente", "err");
    const data = await httpJson(api(`/api/admin/vinculos`), { method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${TOKEN}` }, body: JSON.stringify({ resolucionId, dnis }) });
    if (data.ok) toast(`Vinculados: ${data.vinculados} • Ignorados: ${data.ignorados?.length||0}`); else toast(data.error||"Error","err");
  });

  $("btnVerVinculos")?.addEventListener("click", async ()=>{
    const id = $("resSel")?.dataset.id || "";
    if (!id) return toast("Primero elegí una resolución", "err");
    const list = await httpJson(api(`/api/admin/vinculos/${id}`), { headers:{ Authorization:`Bearer ${TOKEN}` }});
    const c = $("adminLista"); if (!c) return;
    c.innerHTML = `<h4>Vínculos (${list.length})</h4>` + list.map(v => `
      <div class="list-item">
        DNI <b>${v.docenteDni}</b> — Res <code>${v.resolucionId}</code>
        <div class="actions" style="margin-top:6px">
          <button style="background:#e53e3e" onclick="desvincular('${v.resolucionId}','${v.docenteDni}')">Quitar</button>
        </div>
      </div>
    `).join("");
  });
  window.verVinculos = (id)=>{ if ($("resBuscar")) $("resBuscar").value = $("resBuscar").value || "Resolución"; setResSeleccion(id, $("resBuscar")?.value || "Resolución"); $("btnVerVinculos")?.click(); };
  window.desvincular = async (resolucionId, docenteDni) => {
    const data = await httpJson(api(`/api/admin/vinculos`), { method:"DELETE", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${TOKEN}` }, body: JSON.stringify({ resolucionId, docenteDni }) });
    if (data.ok) { toast("Vínculo eliminado"); $("btnVerVinculos").click(); } else toast(data.error||"Error","err");
  };

  // ------- Acuses -------
  $("btnListAcuses")?.addEventListener("click", async () => {
    const list = await httpJson(api(`/api/admin/acuses`), { headers: { Authorization: `Bearer ${TOKEN}` } });
    const c = $("adminLista"); if (!c) return;
    c.innerHTML = `<h4>Acuses (${list.length})</h4>` + list.map(a =>
      `<div class="list-item">✅ ${new Date(a.firmadoEn).toLocaleString()} — DNI ${a.docenteDni} — <b>${a.nombreCompleto}</b> — ${a.email} — Res: <code>${a.resolucionId}</code></div>`
    ).join("");
  });

  // ------- Carga masiva: eventos -------
  $("btnBulkParse")?.addEventListener("click", () => {
    BULK_ROWS = parseBulkInputs();
    renderBulkTable();
    const valid = BULK_ROWS.filter(r => r.ok).length;
    const invalid = BULK_ROWS.length - valid;
    if (!BULK_ROWS.length) toast("No se detectaron filas", "err");
    else if (invalid) toast(`Detectadas ${BULK_ROWS.length}. Válidas: ${valid} • Inválidas: ${invalid}`, "err");
    else toast(`Detectadas ${BULK_ROWS.length} filas válidas ✅`);
  });

  $("btnBulkGuardar")?.addEventListener("click", async () => {
    if (!TOKEN) return toast("Debés iniciar sesión para guardar", "err");
    await bulkGuardar();
  });

  // Estado inicial si ya hay token
  const t = localStorage.getItem("TOKEN");
  if (t) { TOKEN = t; setAuthUI("administrador"); }
});
