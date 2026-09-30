const ORDER_ID_RE = /(?:^|[^0-9])(\d{17})(?![0-9])/;

function readOrderId(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const cleaned = line
      .replace(/[Oo]/g, '0')
      .replace(/[Il|]/g, '1')
      .replace(/S/g, '5')
      .replace(/B/g, '8')
      .replace(/[ \t\-–—_.]/g, '');
    const m = cleaned.match(ORDER_ID_RE);
    if (m) {
      const d = m[1];
      return `${d.slice(0,3)}-${d.slice(3,10)}-${d.slice(10,17)}`;
    }
  }
  return null;
}

console.log(readOrderId("171 - 08910 30 - 2889138"));
console.log(readOrderId("d: 171 - 0891030 - 2889138"));
console.log(readOrderId("Order ID: 171-0891030-2889138"));
