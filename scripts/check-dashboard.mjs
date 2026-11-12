const html = await (await fetch('http://127.0.0.1:9510/audit')).text();
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error('script not found');
try { new Function(match[1]); console.log('script syntax OK'); }
catch (error) { console.error(error); console.log(match[1]); process.exit(1); }
