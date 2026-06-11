export async function onRequestPost({ request, env }) {
  const { msg, model } = await request.json();

  try {
    if(model === 'openrouter'){
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.OPENROUTER_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.1-8b-instruct:free',
          messages: [{role:'user', content: msg}]
        })
      });
      const data = await r.json();
      return Response.json({reply: data.choices[0].message.content});
    }

    if(model === 'openai'){
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.OPENAI_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{role:'user', content: msg}]
        })
      });
      const data = await r.json();
      return Response.json({reply: data.choices[0].message.content});
    }

    if(model === 'hf'){
      const r = await fetch('https://api-inference.huggingface.co/models/HuggingFaceH4/zephyr-7b-beta', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.HF_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({inputs: msg})
      });
      const data = await r.json();
      return Response.json({reply: data[0].generated_text});
    }
  } catch(e){
    return Response.json({error: e.message});
  }
}
