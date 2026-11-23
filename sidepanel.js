const statusEl = document.getElementById('status');
const textEl = document.getElementById('text');
const selectBtn = document.getElementById('select');
const fixHyphensBtn = document.getElementById('fixHyphens');
const makeContinuousBtn = document.getElementById('makeContinuous');
const copyBtn = document.getElementById('copy');
const clearBtn = document.getElementById('clear');

let worker = null;
let selecting = false;

function setStatus(text) {
  statusEl.textContent = text;
}

function updateButtons() {
  selectBtn.disabled = selecting;
  const hasText = textEl.value.trim().length > 0;
  fixHyphensBtn.disabled = !hasText;
  makeContinuousBtn.disabled = !hasText;
  copyBtn.disabled = !hasText;
  clearBtn.disabled = !hasText;
}

textEl.addEventListener('input', updateButtons);

// Spojí slovo rozdělené pomlčkou na konci řádku s jeho pokračováním na dalším
// řádku, např. "prv-\nním" -> "prvním". Řádky, které nekončí pomlčkou mezi
// dvěma písmeny, zůstanou beze změny.
function dehyphenate(text) {
  return text.replace(/([\p{L}])-[ \t]*\r?\n[ \t]*([\p{L}])/gu, '$1$2');
}

// Spojí všechny zalomené řádky (včetně prázdných řádků mezi odstavci) do
// jednoho souvislého textu - nejdřív doplní rozdělená slova, pak nahradí
// zbylé konce řádků mezerou.
function makeContinuous(text) {
  return dehyphenate(text)
    .replace(/[ \t]*\r?\n[ \t]*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function appendText(newText) {
  const trimmed = (newText || '').trim();
  if (!trimmed) return;
  const cleaned = dehyphenate(trimmed);
  textEl.value += (textEl.value.trim().length > 0 ? '\n\n' : '') + cleaned;
  textEl.scrollTop = textEl.scrollHeight;
  updateButtons();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Injected into the page. Lets the user drag a rectangle over the viewport,
// then reports it back to the extension via chrome.runtime.sendMessage.
function startRegionSelection() {
  if (window.__ocrSelActive) return;
  window.__ocrSelActive = true;

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;' +
    'background:rgba(0,0,0,0.25);';

  const box = document.createElement('div');
  box.style.cssText =
    'position:absolute;border:2px dashed #fff;background:rgba(255,255,255,0.15);display:none;';
  overlay.appendChild(box);

  const hint = document.createElement('div');
  hint.textContent = 'Tažením vyber oblast k naskenování · Esc = zrušit';
  hint.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);' +
    'background:#000;color:#fff;padding:4px 10px;border-radius:4px;' +
    'font:12px sans-serif;z-index:2147483647;pointer-events:none;';

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(hint);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  function cleanup() {
    overlay.remove();
    hint.remove();
    document.removeEventListener('keydown', onKey, true);
    window.__ocrSelActive = false;
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      cleanup();
      chrome.runtime.sendMessage({ type: 'ocr-region-cancelled' });
    }
  }

  overlay.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    box.style.left = startX + 'px';
    box.style.top = startY + 'px';
    box.style.width = '0px';
    box.style.height = '0px';
    box.style.display = 'block';
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    cleanup();
    if (w < 4 || h < 4) {
      chrome.runtime.sendMessage({ type: 'ocr-region-cancelled' });
      return;
    }
    chrome.runtime.sendMessage({
      type: 'ocr-region-selected',
      rect: { x, y, width: w, height: h },
      dpr: window.devicePixelRatio || 1
    });
  });

  document.addEventListener('keydown', onKey, true);
}

selectBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus('Žádná aktivní záložka.');
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: startRegionSelection
    });
    selecting = true;
    updateButtons();
    setStatus('Vyber oblast na stránce tažením myši (Esc = zrušit)…');
  } catch (err) {
    setStatus('Na této stránce nelze vybrat oblast (interní nebo chráněná stránka).');
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'ocr-region-selected') {
    selecting = false;
    updateButtons();
    handleRegionSelected(msg.rect, msg.dpr);
  } else if (msg.type === 'ocr-region-cancelled') {
    selecting = false;
    updateButtons();
    setStatus('Zrušeno.');
  }
});

async function ensureWorker() {
  if (worker) return worker;
  setStatus('Načítám OCR engine (poprvé to chvíli trvá)…');
  worker = await Tesseract.createWorker('eng+ces', 1, {
    workerPath: chrome.runtime.getURL('vendor/worker.min.js'),
    corePath: chrome.runtime.getURL('vendor/'),
    langPath: chrome.runtime.getURL('lang'),
    workerBlobURL: false,
    logger: (m) => {
      if (m && m.status) {
        const pct = typeof m.progress === 'number' ? ` ${(m.progress * 100).toFixed(0)}%` : '';
        setStatus(`${m.status}${pct}`);
      }
    }
  });
  return worker;
}

async function cropCapture(dataUrl, rect, dpr) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(
    img,
    rect.x * dpr, rect.y * dpr, rect.width * dpr, rect.height * dpr,
    0, 0, canvas.width, canvas.height
  );
  return canvas.toDataURL('image/png');
}

async function handleRegionSelected(rect, dpr) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    setStatus('Žádná aktivní záložka.');
    return;
  }

  setStatus('Snímám výběr…');
  let shot;
  try {
    shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    setStatus('Snímek se nepodařil: ' + (err && err.message ? err.message : err));
    return;
  }

  let cropped;
  try {
    cropped = await cropCapture(shot, rect, dpr);
  } catch (err) {
    setStatus('Oříznutí snímku se nepodařilo.');
    return;
  }

  try {
    await ensureWorker();
  } catch (err) {
    setStatus('Nepodařilo se spustit OCR engine.');
    return;
  }

  setStatus('Rozpoznávám text…');
  try {
    const { data } = await worker.recognize(cropped);
    const text = (data && data.text ? data.text : '').trim();
    appendText(text);
    setStatus(text ? 'Hotovo.' : 'Hotovo – v oblasti nebyl nalezen žádný text.');
  } catch (err) {
    setStatus('Chyba při rozpoznávání: ' + (err && err.message ? err.message : err));
  }
}

fixHyphensBtn.addEventListener('click', () => {
  const before = textEl.value;
  const after = dehyphenate(before);
  if (after === before) {
    setStatus('Žádné rozdělené slovo nenalezeno.');
    return;
  }
  textEl.value = after;
  updateButtons();
  setStatus('Rozdělená slova spojena.');
});

makeContinuousBtn.addEventListener('click', () => {
  const before = textEl.value;
  const after = makeContinuous(before);
  if (after === before.trim()) {
    setStatus('Text už je souvislý.');
    return;
  }
  textEl.value = after;
  updateButtons();
  setStatus('Text spojen do souvislého odstavce.');
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(textEl.value);
    setStatus('Zkopírováno do schránky.');
  } catch {
    setStatus('Kopírování se nepodařilo.');
  }
});

clearBtn.addEventListener('click', () => {
  if (!window.confirm('Opravdu smazat veškerý text?')) return;
  textEl.value = '';
  updateButtons();
  setStatus('Text vymazán.');
});

updateButtons();
