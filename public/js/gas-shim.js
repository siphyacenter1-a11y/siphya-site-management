// ============================================================
// gas-shim.js — ให้หน้าเว็บที่ย้ายมาจาก Google Apps Script (เรียก google.script.run)
// ทำงานกับ server นี้ได้โดยไม่ต้องแก้โค้ดหน้าเว็บ
// ส่งคำขอไปที่ POST /api/gas  { fn, args }  ->  { ok, result } | { ok:false, error }
// ถ้ายังไม่ได้ login จะพาไปหน้า /login แล้วกลับมาหน้าเดิม
// ============================================================
var GAS_API_URL = '/api/gas';

(function () {
  // เรียก handler ของหน้าเว็บ "นอก" promise (กัน error ใน success handler ไปโผล่เป็น "บันทึกไม่สำเร็จ")
  function later(f, v) {
    if (!f) return;
    setTimeout(function () { f(v); }, 0);
  }

  function goLogin() {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
  }

  function callApi(fn, args, onOk, onFail) {
    fetch(GAS_API_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: args })
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { goLogin(); return null; }
        return r.text();
      })
      .then(function (txt) {
        if (txt === null) return;
        var res;
        try { res = JSON.parse(txt); }
        catch (e) {
          console.error('[gas-shim] ' + fn + ' ตอบกลับไม่ใช่ JSON:', String(txt).slice(0, 500));
          later(onFail, new Error('เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (ดู Console)'));
          return;
        }
        if (res && res.ok) {
          later(onOk, res.result);
        } else {
          var err = new Error((res && res.error) || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
          console.error('[gas-shim] ' + fn + ' error จากเซิร์ฟเวอร์:', err.message);
          later(onFail, err);
        }
      }, function (err) {
        console.error('[gas-shim] เชื่อมต่อ ' + fn + ' ไม่สำเร็จ:', err);
        later(onFail, err);
      });
  }

  // จำลอง google.script.run.withSuccessHandler(...).withFailureHandler(...).ชื่อฟังก์ชัน(args)
  function makeRunner(onOk, onFail) {
    return new Proxy({}, {
      get: function (_, prop) {
        if (prop === 'withSuccessHandler') return function (f) { return makeRunner(f, onFail); };
        if (prop === 'withFailureHandler') return function (f) { return makeRunner(onOk, f); };
        if (prop === 'withUserObject') return function () { return makeRunner(onOk, onFail); };
        return function () {
          callApi(String(prop), Array.prototype.slice.call(arguments), onOk, onFail);
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);
})();

function hubGoHome() { window.location.href = '/'; }

function hubToast(msg, ms) {
  var el = document.getElementById('hubToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window.__hubToastTimer);
  window.__hubToastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 2600);
}
