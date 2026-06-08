export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    // pretty must be inside fetch to see cors
    const pretty = (data) => new Response(JSON.stringify(data, null, 2), {headers: cors});

    if (request.method === 'OPTIONS') {
      return new Response(null, {headers: cors});
    }

    try {
      if (path === '/api/asn' || path === '/api/asn/') {
        return asn(params.get('ip'), request, pretty);
      }
      if (path === '/api/ptr' || path === '/api/ptr/') {
        return ptr(params.get('ip'), request, pretty);
      }

      return pretty({error: 'Use /api/asn or /api/ptr'});
    } catch (e) {
      return pretty({error: e.message, stack: e.stack});
    }
  }
}

function getIP(ipParam, request) {
  if(ipParam) return ipParam;
  const cfIP = request.headers.get('CF-Connecting-IP');
  const xff = request.headers.get('X-Forwarded-For');
  return cfIP || xff?.split(',')[0].trim() || 'unknown';
}

async function asn(ipParam, request, pretty) {
  const ip = getIP(ipParam, request);
  if(ip === 'unknown') return pretty({error: 'IP required'});

  try {
    const r = await fetch(`https://ip-api.com/json/${ip}?fields=status,message,query,country,isp,asname`);
    const data = await r.json();
    if(data.status === 'fail') return pretty({error: data.message});
    return pretty(data);
  } catch(e) {
    return pretty({error: e.message});
  }
}

async function ptr(ipParam, request, pretty) {
  const ip = getIP(ipParam, request);
  if(ip === 'unknown') return pretty({error: 'IP required'});

  if(ip.includes(':')) return pretty({ip, ptr: [], note: 'IPv6 PTR not supported yet'});

  const reversed = ip.split('.').reverse().join('.') + '.in-addr.arpa';
  try {
    const r = await fetch(`https://dns.google/resolve?name=${reversed}&type=PTR`, {
      headers: {'Accept': 'application/dns-json'}
    });

    if(!r.ok) return pretty({ip, ptr: [], query: reversed, error: `HTTP ${r.status}`});

    const json = await r.json();

    if(json.Status === 3) {
      return pretty({ip, ptr: [], query: reversed, status: 'no_record', dns_status: 3});
    }

    const ptrs = json.Answer?.filter(a => a.type === 12).map(a => a.data.replace(/\.$/, '')) || [];

    return pretty({
      ip,
      query: reversed,
      ptr_count: ptrs.length,
      ptr: ptrs,
      status: ptrs.length? 'found' : 'no_record',
      dns_status: json.Status
    });

  } catch(e) {
    return pretty({ip, ptr: [], query: reversed, error: 'Fetch error: ' + e.message});
  }
}
