// อ่านข้อความจากไฟล์ PDF (ใช้ pdfjs-dist ซึ่งเป็น JavaScript ล้วน ไม่ต้องติดตั้งโปรแกรมเพิ่ม)
let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function pdfText(buffer, maxPages) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPages || 10); p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      pages.push(tc.items.map(i => (i.str || '') + (i.hasEOL ? '\n' : ' ')).join(''));
    }
  } finally {
    await doc.destroy();
  }
  return pages.join('\n');
}

module.exports = { pdfText };
