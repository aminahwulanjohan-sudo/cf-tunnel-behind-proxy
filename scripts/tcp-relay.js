// tcp-relay.js — 127.0.0.1:7844 -> proxy CONNECT [ipv6-edge]:7844 -> pipe byte mentah
// Dipakai cloudflared: TLS end-to-end ke edge asli via IPv6 (IPv4 di-kill proxy).
const net = require('net');

const LISTEN_PORT = 7844;
// Edge IPv6 (region1.v2.argotunnel.com AAAA)
// IPv4 + IPv6 — rotasi; keduanya terbukti tembus (IPv4 sempat dibunuh proxy
// pagi 2026-10-02, tapi pulih siang harinya; penyebab tidak diketahui)
const EDGES = ['198.41.192.7', '198.41.200.23',
  '2606:4700:a0::1', '2606:4700:a0::5', '2606:4700:a0::4'];
const PROXY_HOST = process.env.PROXY_HOST || '198.19.0.1';
const PROXY_PORT = 3128;

function proxyPass() {
  const hp = process.env.https_proxy || process.env.http_proxy || '';
  const m = hp.match(/:\/\/[^:]*:([^@]*)@/);
  return m ? m[1] : '';
}

let edgeIdx = 0;

function dialEdge() {
  return new Promise((resolve, reject) => {
    const target = EDGES[edgeIdx % EDGES.length]; edgeIdx++;
    const sock = net.connect({ host: PROXY_HOST, port: PROXY_PORT });
    const auth = Buffer.from('hatch-runtime:' + proxyPass()).toString('base64');
    let buf = Buffer.alloc(0);
    const fail = (msg) => { try { sock.destroy(); } catch (e) {} reject(new Error(msg)); };
    const timer = setTimeout(() => fail('timeout'), 20000);
    sock.on('connect', () => {
      const ht = target.includes(':') ? `[${target}]` : target;
      sock.write(`CONNECT ${ht}:7844 HTTP/1.1\r\nHost: ${ht}:7844\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i === -1) return;
      const head = buf.slice(0, i).toString();
      const rest = buf.slice(i + 4);
      if (!head.includes(' 200')) return fail('CONNECT gagal: ' + head.split('\r\n')[0]);
      clearTimeout(timer);
      sock.removeAllListeners('data');
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    });
    sock.on('error', (e) => fail('proxy: ' + e.message));
  });
}

const server = net.createServer((client) => {
  dialEdge().then((up) => {
    client.pipe(up).pipe(client);
    const dead = () => { try { client.destroy(); } catch (e) {} try { up.destroy(); } catch (e) {} };
    client.on('error', dead); up.on('error', dead);
    client.on('close', dead); up.on('close', dead);
  }).catch((e) => {
    console.log('dial edge gagal:', e.message);
    try { client.destroy(); } catch (ee) {}
  });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`tcp-relay up 127.0.0.1:${LISTEN_PORT} -> proxy -> [edge-ipv6]:7844`);
});
