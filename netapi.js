const NetAPI = {
  base: '/api/',

  async run(tool, params, outId) {
    const out = document.getElementById(outId);
    if(out) out.textContent = 'Loading...';

    const query = new URLSearchParams(params).toString();
    try {
      const res = await fetch(this.base + tool + (query? '?' + query : ''));
      const json = await res.json();
      if(out) out.textContent = JSON.stringify(json, null, 2);
      return json;
    } catch(e) {
      if(out) out.textContent = 'Error: ' + e.message;
    }
  }
}
