// renderer/validation.js  (ES module)

export function collectValidationErrors(doc, pathFor) {
  const errs = new Map();
  const add = (el, msg) => {
    const p = pathFor(el);
    if (!p) return;
    const list = errs.get(p) || [];
    list.push(msg);
    errs.set(p, list);
  };

  // ตัวอย่างกฎทั่วไป: leaf ที่ว่าง หรือเป็น '0' ล้วน ให้แจ้งเตือน
  const all = doc.getElementsByTagName('*');
  for (const el of all) {
    if (el.children.length === 0) {
      const val = (el.textContent || '').trim();
      if (val === '' || /^[0]+$/.test(val)) {
        add(el, 'Empty or zero value');
      }
    }
  }

  // กฎ EMV: value ของ <emvTag> ต้องเป็น HEX
  for (const emvTag of findByLocalName(doc, 'emvTag')) {
    // รองรับทั้งมี namespace หรือไม่มี (เช็คลูกชื่อ value ตามปกติพอ)
    const valueEl = emvTag.querySelector(':scope > value');
    if (valueEl) {
      const hex = (valueEl.textContent || '').trim();
      if (hex && !/^[0-9a-fA-F]+$/.test(hex)) {
        add(valueEl, 'EMV value must be HEX');
      }
    }
  }

  return errs;
}

/**
 * ค้นหา element ตาม localName (ทำงานได้กับ XML ที่มี namespace)
 * ใช้ TreeWalker เดิน DOM แล้วกรองด้วย node.localName
 */
export function findByLocalName(root, ...names) {
  const want = new Set(names.flat().map(String));
  const out = [];
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let n = walker.currentNode;
  while (n) {
    if (want.has(n.localName)) out.push(n);
    n = walker.nextNode();
  }
  return out;
}

/** ตกแต่งปุ่ม node ใน tree ถ้า path นั้นมี error */
export function decorateTreeWithErrors(treeRootEl, errorMap) {
  const btns = treeRootEl.querySelectorAll('button.node');
  btns.forEach(btn => {
    btn.classList.remove('has-error');
    const path = btn.textContent;
    if (errorMap.has(path)) btn.classList.add('has-error');
  });
}

/** การ์ดแสดง error ในฝั่งขวา */
export function errorCard(messages) {
  const wrap = document.createElement('div');
  wrap.className = 'card error';
  const h = document.createElement('h3'); h.textContent = 'Validation errors';
  const ul = document.createElement('ul');
  for (const m of messages) {
    const li = document.createElement('li'); li.textContent = m; ul.appendChild(li);
  }
  wrap.appendChild(h); wrap.appendChild(ul);
  return wrap;
}
