"""AgentShield form benchmark, browser-use arm: the same LLM drives browser-use 1.x (default settings) on the same forms.

Each session gets a fresh temporary browser profile; sessions run concurrently in independent browsers and are told apart
by the page's sessionStorage id. The task prompt is the paper's dynamic_form_prompt.txt with the URL pointed at the local
test site. Telemetry is copied to results/<form>/<label>/ for score.py.

    LLM_BASE_URL / LLM_API_KEY / LLM_MODEL   OpenAI-compatible endpoint, key and model (same as run_waymark.mjs)
    AGENTSHIELD                              path to the AgentShield artifact checkout

    python run_browser_use.py --form simpleForm|dynamicForm --n 10 [--concurrency 4]
"""
import argparse, asyncio, json, os, subprocess, time, urllib.request
from pathlib import Path

os.environ['ANONYMIZED_TELEMETRY'] = 'false'
from browser_use import Agent, Browser, ChatOpenAI

RUNS = Path(__file__).resolve().parent
REPO = Path(os.environ.get('AGENTSHIELD', RUNS / 'AgentShield')).resolve()
SITE = REPO / 'TestSite'
PORT = 5001
ROUTE = {'simpleForm': '/pledge-form', 'dynamicForm': '/dynamic-form'}


def task_for(form):
    prompt = (REPO / 'FormInteraction' / 'dynamic_form_prompt.txt').read_text(encoding='utf-8')
    return prompt.replace('https://example.com/dynamic-form', f'http://127.0.0.1:{PORT}{ROUTE[form]}')


def site_logs():
    return SITE / 'interaction-log.jsonl', SITE / 'logs' / 'tracker-log.jsonl'


def start_site():
    (SITE / 'logs').mkdir(exist_ok=True)
    for p in site_logs():
        p.unlink(missing_ok=True)
    out = open(RUNS / 'results' / 'site-server.log', 'a', encoding='utf-8')
    proc = subprocess.Popen(['node', 'server.js'], cwd=SITE, stdout=out, stderr=out, env=dict(os.environ, PORT=str(PORT)))
    for _ in range(50):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/', timeout=1)
            return proc
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit('site did not start')


async def one(form, model, i, meta):
    llm = ChatOpenAI(model, api_key=os.environ['LLM_API_KEY'], base_url=os.environ.get('LLM_BASE_URL', 'https://api.deepseek.com/v1'))
    browser = Browser('chromium', headless=True)
    agent = Agent(task_for(form), llm, browser=browser, use_vision=False, judge=False)
    t = time.time()
    rec = {'form': form, 'run': i, 'model': model, 'start': t}
    try:
        h = await agent.run(max_steps=40, timeout=900)
        rec.update(done=h.is_done(), success=h.is_successful(), steps=h.number_of_steps(),
                   final=(h.final_result() or '')[:600], errors=[e for e in h.errors() if e][:5])
    except Exception as e:
        rec.update(done=False, error=repr(e)[:600])
    rec['seconds'] = round(time.time() - t, 1)
    meta.write(json.dumps(rec, ensure_ascii=False) + '\n'); meta.flush()
    print(json.dumps({k: rec.get(k) for k in ('form', 'run', 'done', 'success', 'steps', 'seconds', 'error')}, ensure_ascii=False), flush=True)
    await asyncio.sleep(3)  # tracker 每 2s 批量上报，留出最后一批


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--form', choices=list(ROUTE), required=True)
    ap.add_argument('--n', type=int, default=10)
    ap.add_argument('--label', default='browser_use')
    ap.add_argument('--model', default=os.environ.get('LLM_MODEL', 'deepseek-chat'))
    ap.add_argument('--concurrency', type=int, default=4)
    a = ap.parse_args()
    dest = RUNS / 'results' / a.form / a.label
    dest.mkdir(parents=True, exist_ok=True)
    proc = start_site()
    try:
        sem = asyncio.Semaphore(a.concurrency)

        async def slot(i, meta):
            async with sem:
                await one(a.form, a.model, i, meta)

        with open(dest / 'runs.jsonl', 'a', encoding='utf-8') as meta:
            await asyncio.gather(*(slot(i, meta) for i in range(a.n)))
    finally:
        await asyncio.sleep(3)
        proc.terminate()
        inter, tracker = site_logs()
        for src, name in ((inter, 'interaction-log.jsonl'), (tracker, 'tracker-log.jsonl')):
            if src.exists():
                with open(dest / name, 'ab') as f:
                    f.write(src.read_bytes())
        print('logs ->', dest, flush=True)


if __name__ == '__main__':
    asyncio.run(main())
