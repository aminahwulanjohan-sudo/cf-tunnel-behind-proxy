// Mini DNS via TCP (UDP diblokir container)
const net = require('net');

function buildSRVResponse(query) {
  const id = query.readUInt16BE(0);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(2, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const qEnd = query.indexOf(0, 12) + 5;
  const question = query.slice(12, qEnd);
  function srvRecord(priority, weight, port, target) {
    const labels = target.split('.').map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
    const targetBuf = Buffer.concat([...labels, Buffer.from([0])]);
    const rdata = Buffer.alloc(6 + targetBuf.length);
    rdata.writeUInt16BE(priority, 0);
    rdata.writeUInt16BE(weight, 2);
    rdata.writeUInt16BE(port, 4);
    targetBuf.copy(rdata, 6);
    const rr = Buffer.alloc(12);
    rr[0] = 0xc0; rr[1] = 0x0c;
    rr.writeUInt16BE(33, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(300, 6);
    rr.writeUInt16BE(rdata.length, 10);
    return Buffer.concat([rr, rdata]);
  }
  const body = Buffer.concat([
    header, question,
    srvRecord(1, 1, 7844, 'region1.v2.argotunnel.com'),
    srvRecord(2, 1, 7844, 'region2.v2.argotunnel.com')
  ]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length, 0);
  return Buffer.concat([len, body]);
}

const EDGE_IPS = {
  // via ws-relay lokal (127.0.0.1:7844 -> wss worker -> TCP edge:7844)
  'region1.v2.argotunnel.com': '127.0.0.1',
  'region2.v2.argotunnel.com': '127.0.0.1',
};

// Baca /etc/hosts untuk nama internal (mis. hatch-egress-proxy)
const HOSTS_MAP = {};
try {
  const fs = require('fs');
  for (const line of fs.readFileSync('/etc/hosts', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(parts[0])) {
      for (const h of parts.slice(1)) HOSTS_MAP[h.toLowerCase()] = parts[0];
    }
  }
} catch (e) {}
function lookupA(name) {
  const n = name.toLowerCase();
  return EDGE_IPS[n] || HOSTS_MAP[n] || null;
}

function buildAResponse(query, ip) {
  const id = query.readUInt16BE(0);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const qEnd = query.indexOf(0, 12) + 5;
  const question = query.slice(12, qEnd);
  const rr = Buffer.alloc(12);
  rr[0] = 0xc0; rr[1] = 0x0c;
  rr.writeUInt16BE(1, 2);   // TYPE A
  rr.writeUInt16BE(1, 4);   // CLASS IN
  rr.writeUInt32BE(300, 6); // TTL
  rr.writeUInt16BE(4, 10);  // RDLENGTH
  const rdata = Buffer.from(ip.split('.').map(Number));
  const body = Buffer.concat([header, question, rr, rdata]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length, 0);
  return Buffer.concat([len, body]);
}

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (data) => {
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 2) {
      const len = buf.readUInt16BE(0);
      if (buf.length < 2 + len) break;
      const query = buf.slice(2, 2 + len);
      buf = buf.slice(2 + len);
      // Parse qname
      const qname = [];
      let i = 12;
      while (query[i] !== 0 && i < query.length) {
        const l = query[i]; i++;
        qname.push(query.slice(i, i + l).toString()); i += l;
      }
      const name = qname.join('.');
      const qtype = query.readUInt16BE(i + 1);
      if ((name.includes('origintunneld') || name.includes('argotunnel')) && qtype === 33) {
        sock.write(buildSRVResponse(query));
      } else if (qtype === 1) {
        const ip = lookupA(name);
        if (ip) {
          sock.write(buildAResponse(query, ip));
        } else {
          // NXDOMAIN untuk yang lain
          const id = query.readUInt16BE(0);
          const h = Buffer.alloc(12);
          h.writeUInt16BE(id, 0); h.writeUInt16BE(0x8183, 2);
          h.writeUInt16BE(1, 4); h.writeUInt16BE(0, 6);
          const qEnd = query.indexOf(0, 12) + 5;
          const body = Buffer.concat([h, query.slice(12, qEnd)]);
          const l = Buffer.alloc(2); l.writeUInt16BE(body.length, 0);
          sock.write(Buffer.concat([l, body]));
        }
      }
    }
  });
});

server.listen(53, '127.0.0.1', () => console.log('TCP DNS up 127.0.0.1:53'));
