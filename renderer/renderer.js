document.addEventListener('DOMContentLoaded', () => {
  // ===== Elements (XML) =====
  const openBtn    = document.getElementById('openBtn');
  const search     = document.getElementById('search');
  const treeEl     = document.getElementById('tree');
  const detailsEl  = document.getElementById('details');
  const fileNameEl = document.getElementById('fileName');

  // ===== Tabs / Pages =====
  const tabXml = document.getElementById('tab-xml');
  const tabDeny = document.getElementById('tab-deny');
  const viewXml = document.getElementById('view-xml');
  const viewDeny = document.getElementById('view-deny');

  function activateTab(which) {
    if (which === 'xml') {
      tabXml?.classList.add('active'); tabDeny?.classList.remove('active');
      viewXml.hidden = false; viewDeny.hidden = true;
      viewXml.scrollTop = 0;
    } else {
      tabDeny?.classList.add('active'); tabXml?.classList.remove('active');
      viewDeny.hidden = false; viewXml.hidden = true;
      viewDeny.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  }
  window.activateTab = activateTab;

  // ===== Elements (DenyList) =====
  const els = () => ({
    openDenyBtn:   document.getElementById('openDenyBtn'),
    panSearch:     document.getElementById('panSearch'),
    filterRemoved: document.getElementById('filterRemoved'),
    filterReason:  document.getElementById('filterReason'),
    denyFileName:  document.getElementById('denyFileName'),
    denyStats:     document.getElementById('denyStats'),
    denyTBody:     document.querySelector('#denyTable tbody'),
    exportJson:    document.getElementById('exportDenyJson'),
    exportCsv:     document.getElementById('exportDenyCsv'),
  });

  // ===== State =====
  let currentDoc = null;
  let denyModel = null;             // { entries: [], reasons: {} }
  let denySort  = { key: null, dir: 'asc' }; // 'pan' | 'removed' | 'reasons'

  // ===== Utils =====
  const isXmlPath  = (p) => p?.toLowerCase().endsWith('.xml');
  const isDenyPath = (p) => p && (p.toLowerCase().endsWith('.bin') || p.toLowerCase().endsWith('.zip'));

  function parseXml(xmlStr) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlStr, 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error(err.textContent || 'XML parse error');
    return doc;
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
  function pathFor(node) {
    if (!node || node.nodeType !== 1) return '';
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1) {
      const ix = indexAmongSiblings(cur);
      const name = cur.nodeName.replace(/^.*:/, '');
      parts.unshift(ix > 1 ? `${name}[${ix}]` : name);
      cur = cur.parentElement;
    }
    return parts.slice(1).join('.');
  }
  function kvTable(title, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'card';
    const h = document.createElement('h3'); h.textContent = title;
    const table = document.createElement('table'); table.className = 'kv';
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td'); td1.textContent = k;
      const td2 = document.createElement('td'); td2.textContent = v ?? '';
      tr.appendChild(td1); tr.appendChild(td2);
      table.appendChild(tr);
    }
    wrap.appendChild(h); wrap.appendChild(table);
    return wrap;
  }
  function codeBlock(title, content) {
    const wrap = document.createElement('div');
    wrap.className = 'card';
    const h = document.createElement('h3'); h.textContent = title;
    const pre = document.createElement('pre'); pre.textContent = content ?? '';
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

  // ===== Clear helpers =====
  function clearXmlView() {
    currentDoc = null;
    treeEl.innerHTML = '';
    detailsEl.innerHTML = '<div class="placeholder">Select a field from the left to view details.</div>';
    if (search) search.value = '';
    if (fileNameEl) fileNameEl.textContent = 'Drop an XML file here or click Open';
  }
  function clearDenyView() {
    denyModel = null;
    const { denyStats, denyTBody, panSearch, denyFileName, filterRemoved, filterReason } = els();
    if (denyStats) denyStats.textContent = '';
    if (denyTBody) denyTBody.innerHTML = '';
    if (panSearch) panSearch.value = '';
    if (denyFileName) denyFileName.textContent = 'No file opened';
    if (filterRemoved) filterRemoved.value = 'all';
    if (filterReason)  filterReason.innerHTML = '<option value="all">All reasons</option>';
    denySort = { key: null, dir: 'asc' };
  }

  // ===== XML Tree =====
  function buildTree(doc) {
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

    const attrs = el.getAttributeNames();
    if (attrs.length) detailsEl.appendChild(kvTable('Attributes', attrs.map(a => [a, el.getAttribute(a)])));

    const rows = [];
    for (const child of el.children) {
      const key = child.nodeName.replace(/^.*:/, '');
      const text = child.children.length ? `(${child.children.length} children)` : (child.textContent || '').trim();
      rows.push([key, text]);
    }
    if (rows.length) detailsEl.appendChild(kvTable('Children', rows));

    if (!el.children.length) {
      const val = (el.textContent || '').trim();
      if (val) detailsEl.appendChild(codeBlock('Value', val));
    }

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

  // ===== DenyList helpers =====
  function normalizeDenyData(raw) {
    if (!raw) return { entries: [], reasons: {} };
    const reasons = raw.reasons || {};
    const normEntries = [];

    function toArr(x) {
      if (Array.isArray(x)) return x;
      if (typeof x === 'string') return x.split(',').map(s => s.trim()).filter(Boolean);
      return [];
    }

    if (Array.isArray(raw.entries)) {
      for (const e of raw.entries) {
        const labelsArr = toArr(e.reason_labels);
        normEntries.push({
          pan: e.pan ?? e.surrogate_pan ?? '',
          removed: typeof e.removed === 'boolean' ? String(e.removed) : (e.removed ?? ''),
          removed_present: typeof e.removed_present === 'boolean' ? String(e.removed_present) : (e.removed_present ?? ''),
          reason_ids: Array.isArray(e.reason_ids) ? e.reason_ids.join(',') : (e.reason_ids ?? ''),
          reason_labels: labelsArr.join(','),
          reason_labels_arr: labelsArr,
        });
      }
    } else if (raw.entries_by_pan && typeof raw.entries_by_pan === 'object') {
      for (const [pan, e] of Object.entries(raw.entries_by_pan)) {
        const labelsArr = toArr(e.reason_labels);
        normEntries.push({
          pan,
          removed: typeof e.removed === 'boolean' ? String(e.removed) : (e.removed ?? ''),
          removed_present: typeof e.removed_present === 'boolean' ? String(e.removed_present) : (e.removed_present ?? ''),
          reason_ids: Array.isArray(e.reason_ids) ? e.reason_ids.join(',') : (e.reason_ids ?? ''),
          reason_labels: labelsArr.join(','),
          reason_labels_arr: labelsArr,
        });
      }
    }
    return { entries: normEntries, reasons };
  }

  function populateReasonFilter() {
    const { filterReason } = els();
    if (!filterReason) return;
    const options = ['<option value="all">All reasons</option>'];
    if (denyModel?.entries?.length) {
      const set = new Set();
      for (const e of denyModel.entries) {
        (e.reason_labels_arr || []).forEach(r => set.add(String(r)));
      }
      const arr = Array.from(set).sort((a,b)=>a.localeCompare(b));
      for (const r of arr) options.push(`<option value="${r}">${r}</option>`);
    }
    filterReason.innerHTML = options.join('');
  }

  function renderDenyModel() {
    const { denyStats, denyTBody, panSearch, filterRemoved, filterReason } = els();
    if (!denyModel || !denyTBody) return;

    const all = Array.isArray(denyModel.entries) ? denyModel.entries.slice() : [];
    const reasonsMap = denyModel.reasons || {};

    // filters
    const q = (panSearch?.value || '').trim().toLowerCase();
    const rem = (filterRemoved?.value || 'all').toLowerCase();
    const rea = (filterReason?.value  || 'all');

    let rows = all;
    if (q) rows = rows.filter(e => (e.pan || '').toLowerCase().includes(q));
    if (rem !== 'all') rows = rows.filter(e => String(e.removed) === rem);
    if (rea !== 'all') rows = rows.filter(e => (e.reason_labels_arr || []).includes(rea));

    // sort
    if (denySort.key) {
      const key = denySort.key;
      const dir = denySort.dir === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const av = key === 'removed'
          ? (String(a.removed) === 'true' ? 1 : 0)
          : (key === 'reasons'
              ? (a.reason_labels || '')
              : (a.pan || '')
            ).toString().toLowerCase();
        const bv = key === 'removed'
          ? (String(b.removed) === 'true' ? 1 : 0)
          : (key === 'reasons'
              ? (b.reason_labels || '')
              : (b.pan || '')
            ).toString().toLowerCase();
        if (av < bv) return -1 * dir;
        if (av > bv) return  1 * dir;
        return 0;
      });
    }

    // stats
    const removedTrue = rows.filter(e => String(e.removed) === 'true').length;
    if (denyStats) {
      denyStats.textContent = `Entries: ${rows.length} • Removed=true: ${removedTrue} • Reasons: ${Object.keys(reasonsMap).length}`;
    }

    // table body
    denyTBody.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="3" style="opacity:.8">No entries.</td>`;
      denyTBody.appendChild(tr);
    } else {
      for (const e of rows) {
        const pan = e.pan ?? '';
        const removed = (typeof e.removed === 'boolean') ? String(e.removed) : (e.removed ?? '');
        const reasonLabels = e.reason_labels ?? '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td title="${pan}">${pan}</td>
          <td title="${removed}">${removed}</td>
          <td title="${reasonLabels}">${reasonLabels}</td>
        `;
        denyTBody.appendChild(tr);
      }
    }

    // sort arrows
    const ths = document.querySelectorAll('#denyTable thead th.th-sort');
    ths.forEach(th => {
      th.classList.remove('sort-asc','sort-desc');
      if (th.dataset.sort && th.dataset.sort === denySort.key) {
        th.classList.add(denySort.dir === 'desc' ? 'sort-desc' : 'sort-asc');
      }
    });
  }

  // ===== Open DenyList =====
  async function openDenyWithPath(filePath) {
    try {
      els().denyFileName.textContent = filePath;
      const parsed = await window.api.parseDeny(filePath, { suppressIdWarn: true });
      if (!parsed?.ok) {
        console.error(parsed?.error);
        alert('Failed to parse deny list: ' + parsed?.error);
        return;
      }
      denyModel = normalizeDenyData(parsed.data);
      populateReasonFilter();
      renderDenyModel();
      activateTab('deny');
      clearXmlView();
    } catch (err) {
      console.error(err);
      alert('Failed: ' + (err?.message || err));
    }
  }
  async function openDenyByDialog() {
    const result = await window.api.openDialog();
    if (!result) return;
    await openDenyWithPath(result.filePath);
  }

  // ===== Open-any (auto route) =====
  async function openAny() {
    const result = await window.api.openDialog();
    if (!result) return;
    const { filePath, xml } = result;
    fileNameEl.textContent = filePath;

    if (isXmlPath(filePath)) {
      try {
        currentDoc = parseXml(xml);
        buildTree(currentDoc);
        detailsEl.innerHTML = '<div class="placeholder">Select a field from the left to view details.</div>';
        activateTab('xml');
        clearDenyView();
      } catch (e) {
        alert('Failed to open XML: ' + (e?.message || e));
      }
    } else if (isDenyPath(filePath)) {
      await openDenyWithPath(filePath);
    } else {
      alert('Unsupported file type. Please select .xml / .bin / .zip');
    }
  }

  // ===== Wiring =====
  tabXml?.addEventListener('click', () => { activateTab('xml');  clearDenyView(); });
  tabDeny?.addEventListener('click', () => { activateTab('deny'); clearXmlView();  });

  // XML search
  search?.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    const items = treeEl.querySelectorAll('button.node');
    for (const btn of items) {
      const match = btn.textContent.toLowerCase().includes(q);
      btn.parentElement.style.display = match ? '' : 'none';
    }
  });

  // Drag & drop
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const p = file.path;
    if (isXmlPath(p)) {
      const { filePath, xml } = await window.api.readDropped(p);
      fileNameEl.textContent = filePath;
      try {
        currentDoc = parseXml(xml);
        buildTree(currentDoc);
        detailsEl.innerHTML = '<div class="placeholder">Select a field from the left to view details.</div>';
        activateTab('xml');
        clearDenyView();
      } catch (e) {
        alert('Failed to open XML: ' + (e?.message || e));
      }
    } else if (isDenyPath(p)) {
      await openDenyWithPath(p);
    } else {
      alert('Please drop .xml / .bin / .zip');
    }
  });

  // Buttons / Shortcuts
  openBtn?.addEventListener('click', openAny);
  els().openDenyBtn?.addEventListener('click', openDenyByDialog);
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'o' && !e.shiftKey) { e.preventDefault(); openAny(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openDenyByDialog(); }
  });

  // Filters + search (DenyList)
  els().panSearch?.addEventListener('input', () => renderDenyModel());
  els().filterRemoved?.addEventListener('change', () => renderDenyModel());
  els().filterReason?.addEventListener('change', () => renderDenyModel());

  // Sorting header
  (function setupDenySorting(){
    const thead = document.querySelector('#denyTable thead');
    if (!thead) return;
    thead.addEventListener('click', (e) => {
      const th = e.target.closest('th.th-sort');
      if (!th || !th.dataset.sort) return;
      const key = th.dataset.sort;
      if (denySort.key === key) denySort.dir = (denySort.dir === 'asc') ? 'desc' : 'asc';
      else denySort = { key, dir: 'asc' };
      renderDenyModel();
    });
  })();

  // Default
  activateTab('xml');
  clearDenyView();
});
