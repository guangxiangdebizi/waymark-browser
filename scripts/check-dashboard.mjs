const html = await (await fetch('http://127.0.0.1:9510/audit')).text();
const sources = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
if (!sources.length) throw new Error('scripts not found');
for (const source of sources) {
  const script = await (await fetch(new URL(source, 'http://127.0.0.1:9510'))).text();
  new Function(script);
}
console.log('script syntax OK');
