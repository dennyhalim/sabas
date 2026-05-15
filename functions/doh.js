export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Get device log from path or query param
    const pathParts = url.pathname.split('/').filter(Boolean);
    const deviceLog = pathParts.length > 1? pathParts[1] : url.searchParams.get('device');

    // Forward to upstream DoH
    const upstreamUrl = new URL('https://cloudflare-dns.com/dns-query');
    upstreamUrl.search = url.search;

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('accept', 'application/dns-message');
    if (deviceLog) headers.set('X-Device-Log', deviceLog);

    const upstreamResp = await fetch(new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === 'POST'? request.body : null
    }));

    if (!upstreamResp.ok || upstreamResp.headers.get('content-type')!== 'application/dns-message') {
      return upstreamResp;
    }

    const dnsBuffer = await upstreamResp.arrayBuffer();
    const modifiedBuffer = modifyTTLs(dnsBuffer, 10);

    return new Response(modifiedBuffer, {
      headers: {
        'content-type': 'application/dns-message',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*'
      }
    });
  }
}

function modifyTTLs(buffer, factor) {
  const view = new DataView(buffer);
  let offset = 12; // skip DNS header

  const ancount = view.getUint16(6);
  const nscount = view.getUint16(8);
  const arcount = view.getUint16(10);

  // Skip question section
  const qdcount = view.getUint16(4);
  for (let i = 0; i < qdcount; i++) {
    offset = skipName(view, offset);
    offset += 4;
  }

  // Process only Answer, Authority, Additional sections
  offset = processSection(view, offset, ancount, factor);
  offset = processSection(view, offset, nscount, factor);
  offset = processSection(view, offset, arcount, factor);

  return buffer;
}

function processSection(view, offset, count, factor) {
  for (let i = 0; i < count; i++) {
    offset = skipName(view, offset);
    const type = view.getUint16(offset);
    offset += 4; // TYPE + CLASS
    const ttl = view.getUint32(offset);

    // Only modify A(1), AAAA(28), CNAME(5)
    if (type === 1 || type === 28 || type === 5) {
      view.setUint32(offset, ttl * factor);
    }
    offset += 4; // TTL

    const rdlength = view.getUint16(offset);
    offset += 2 + rdlength; // RDLENGTH + RDATA
  }
  return offset;
}

function skipName(view, offset) {
  while (offset < view.byteLength) {
    const len = view.getUint8(offset);
    if (len === 0) return offset + 1;
    if ((len & 0xC0) === 0xC0) return offset + 2; // compression pointer
    offset += len + 1;
  }
  return offset;
}
