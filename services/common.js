// ของที่ใช้ร่วมกันระหว่างระบบที่ย้ายมาจาก Apps Script (เช็คลิสต์, ขยะ, ...)
const { sitePool } = require('../db');

// ข้อผิดพลาดที่ผู้ใช้ควรเห็น (ข้อความภาษาไทย) — /api/gas ส่งข้อความนี้กลับไปตรงๆ
class UserError extends Error {}

async function withTx(fn) {
  const client = await sitePool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Chrome สำหรับทำ PDF (เปิดครั้งเดียว ใช้ร่วมกันทุกระบบ)
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    const puppeteer = require('puppeteer');
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    }).then(b => {
      // ถ้า Chrome ปิดหรือ crash ไป ให้เปิดใหม่ในครั้งถัดไป (ไม่งั้นทำ PDF ไม่ได้จนกว่าจะ restart server)
      b.on('disconnected', () => { browserPromise = null; });
      return b;
    }).catch(err => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

async function renderPdf(html, pdfOptions) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: 'load', timeout: 120000 });
    return await page.pdf(Object.assign({ printBackground: true, preferCSSPageSize: true }, pdfOptions || {}));
  } finally {
    await page.close().catch(() => {});
  }
}

async function htmlToPdf(html, pdfOptions) {
  try {
    return await renderPdf(html, pdfOptions);
  } catch (err) {
    // Chrome หลุดระหว่างทำ → เปิดใหม่แล้วลองอีกครั้งเดียว
    if (/Connection closed|Target closed|Session closed|browser has disconnected/i.test(String(err && err.message))) {
      browserPromise = null;
      return renderPdf(html, pdfOptions);
    }
    throw err;
  }
}

module.exports = { UserError, withTx, getBrowser, htmlToPdf };
