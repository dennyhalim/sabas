export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {headers: cors});
    }

    try {
      if (path === '/api/asn') {
        const ip = params.get('ip') || request.headers.get('CF-Connecting-IP') || 'unknown';
        if(ip === 'unknown') return new Response(JSON.stringify({error: 'IP required'}, null, 2), {headers: cors});
        
        const r = await fetch(`https://ip-api.com/json/${ip}?fields=query,country,isp,asname`);
        const data = await r.json();
        return new Response(JSON.stringify(data, null, 2), {headers: cors});
      }

      if (path === '/api/ptr') {
        const ip = params.get('ip') || request.headers.get('CF-Connecting-IP') || 'unknown';
        if(ip === 'unknown') return new Response(JSON.stringify({error: 'IP required'}, null, 2), {headers: cors});
        if(ip.includes(':')) return new Response(JSON.stringify({ip, ptr: []}, null, 2), {headers: cors});

        const reversed = ip.split('.').reverse().join('.') + '.in-addr.arpa';
        const r = await fetch(`https://dns.google/resolve?name=${reversed}&type=PTR`, {
          headers: {'Accept': 'application/dns-json'}
        });
        const json = await r.json();
        const ptrs = json.Answer?.filter(a => a.type === 12).map(a => a.data.replace(/\.$/, '')) || [];
        
        return new Response(JSON.stringify({
          ip,
          ptr_count: ptrs.length,
          ptr: ptrs,
          status: ptrs.length ? 'found' : 'no_record'
        }, null, 2), {headers: cors});
      }

      return new Response(JSON.stringify({error: 'Use /api/asn or /api/ptr'}, null, 2), {headers: cors});
    } catch (e) {
      return new Response(JSON.stringify({error: e.message, stack: e.stack}, null, 2), {headers: cors});
    }
  }
}
