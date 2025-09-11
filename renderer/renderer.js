const openBtn = document.getElementById('openBtn');
const search = document.getElementById('search');
const treeEl = document.getElementById('tree');
const detailsEl = document.getElementById('details');
const fileNameEl = document.getElementById('fileName');

let currentDoc = null;
let flatIndex = []; // { path, node }

function parseXml(xmlStr) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(err.textContent || 'XML parse error');
  return doc;
}

function pathFor(node) {
  if (!node || node.nodeType !== 1) return '';
  const parts = [];
  let cur = node;
  while (cur && cur.nodeType === 1) {
    const ix = indexAmongSiblings(cur);
    const name = cur.nodeName.replace(/^.*:/, ''); // strip ns
    parts.unshift(ix > 1 ? `${name}[${ix}]` : name);
    cur = cur.parentElement;
  }
  // remove #document
  return parts.slice(1).join('.');
}

function indexAmongSiblings(el) {
  if (!el.parentElement) return 1;
  let ix = 1;
  for (const sib of el.parentElement.children) {
    if (sib === el) break;
    if (sib.nodeName === el.nodeName) ix++;
  }
  return ix;
}

function buildTree(doc) {
  flatIndex = [];
  const root = doc.documentElement;
  treeEl.innerHTML = '';
  const ul = document.createElement('ul');
  ul.className = 'tree';
  ul.appendChild(renderNode(root));
  treeEl.appendChild(ul);
}

function renderNode(el) {
  const li = document.createElement('li');
  const toggle = document.createElement('button');
  toggle.className = 'node';
  const label = el.nodeName.replace(/^.*:/, '');
  const p = pathFor(el);
  toggle.textContent = p || label;
  toggle.title = label;
  toggle.onclick = () => showDetails(el);
  li.appendChild(toggle);

  // add to index for search
  flatIndex.push({ path: p || label, node: el });

  const childrenEls = Array.from(el.children || []);
  if (childrenEls.length) {
    const sub = document.createElement('ul');
    sub.className = 'tree';
    for (const c of childrenEls) sub.appendChild(renderNode(c));
    li.appendChild(sub);
  }
  return li;
}

function showDetails(el) {
  detailsEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'detail-header';
  header.innerHTML = `<h2>${el.nodeName}</h2><code class="path">${pathFor(el)}</code>`;
  detailsEl.appendChild(header);

  // Attributes table
  const attrs = el.getAttributeNames();
  if (attrs.length) {
    detailsEl.appendChild(kvTable('Attributes', attrs.map(a => [a, el.getAttribute(a)])));
  }

  // Child elements preview
  const rows = [];
  for (const child of el.children) {
    const key = child.nodeName.replace(/^.*:/, '');
    const text = child.children.length ? `(${child.children.length} children)` : (child.textContent || '').trim();
    rows.push([key, text]);
  }
  if (rows.length) detailsEl.appendChild(kvTable('Children', rows));

/* Text content (if leaf) */
  if (!el.children.length) {
    const val = (el.textContent || '').trim();
    if (val) detailsEl.appendChild(codeBlock('Value', val));
  }

  // EMV helper: pretty hex to ASCII for common tags
  if (/emvTag$/i.test(el.nodeName) || el.closest('emvTags')) {
    const name = el.querySelector(':scope > name')?.textContent?.trim();
    const val = el.querySelector(':scope > value')?.textContent?.trim();
    if (val && /^[0-9a-fA-F]+$/.test(val)) {
      detailsEl.appendChild(codeBlock('Hex', val));
      const ascii = hexToAscii(val);
      if (ascii) detailsEl.appendChild(codeBlock('ASCII', ascii));
    }
    if (name) detailsEl.appendChild(codeBlock('EMV Tag', name));
  }
}

function kvTable(title, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  const h = document.createElement('h3');
  h.textContent = title;
  wrap.appendChild(h);
  const table = document.createElement('table');
  table.className = 'kv';
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = k;
    const td2 = document.createElement('td');
    td2.textContent = v || '';
    tr.appendChild(td1); tr.appendChild(td2);
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

function codeBlock(title, content) {
  const wrap = document.createElement('div');
  wrap.className = 'card';
  const h = document.createElement('h3');
  h.textContent = title;
  const pre = document.createElement('pre');
  pre.textContent = content;
  wrap.appendChild(h); wrap.appendChild(pre);
  return wrap;
}

function hexToAscii(hex) {
  try {
    const bytes = hex.match(/.{1,2}/g).map(h => parseInt(h, 16));
    if (bytes.some(n => isNaN(n))) return '';
    return String.fromCharCode(...bytes);
  } catch { return ''; }
}

async function openXml() {
  try {
    const result = await window.api.openDialog();
    if (!result) return;
    const { filePath, xml } = result;
    fileNameEl.textContent = filePath;
    currentDoc = parseXml(xml);
    buildTree(currentDoc);
    detailsEl.innerHTML = '<div class="placeholder">Select a field from the left to view details.</div>';
  } catch (err) {
    alert('Failed to open XML: ' + err.message);
  }
}

// search filtering
search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  const items = treeEl.querySelectorAll('button.node');
  for (const btn of items) {
    const match = btn.textContent.toLowerCase().includes(q);
    btn.parentElement.style.display = match ? '' : 'none';
  }
});

// drag & drop
window.addEventListener('dragover', e => { e.preventDefault(); });
window.addEventListener('drop', async e => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.path.toLowerCase().endsWith('.xml')) {
    alert('Please drop an .xml file');
    return;
  }
  const { filePath, xml } = await window.api.readDropped(file.path);
  fileNameEl.textContent = filePath;
  currentDoc = parseXml(xml);
  buildTree(currentDoc);
});

openBtn.addEventListener('click', openXml);

// keyboard shortcut
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    openXml();
  }
});
