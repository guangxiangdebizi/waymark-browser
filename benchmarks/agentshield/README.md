# AgentShield form benchmark

Reproduces the comparison in [docs/benchmark-agentshield.md](../../docs/benchmark-agentshield.md): the same LLM fills the
[AgentShield](https://arxiv.org/abs/2610.41181) (IEEE S&P 2027) test forms through **browser-use** and through **Waymark**,
and the paper's own detector plus a stricter human-range check score every session.

## Setup

1. Get the AgentShield artifact repository (test site, logs and trained detectors) and install the test site:

   ```bash
   git clone https://github.com/moizali01/AgentShield-SP27 AgentShield
   (cd AgentShield/TestSite && npm init -y && npm install express cors axios body-parser dotenv)
   python -m pip install numpy pandas scikit-learn joblib
   ```

2. Build Waymark (repository root): `npm ci && npm run build`.
3. For the browser-use arm: `python -m pip install browser-use`.
4. Point both arms at the same OpenAI-compatible model:

   ```bash
   export LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=sk-... LLM_MODEL=deepseek-chat
   export AGENTSHIELD=$PWD/AgentShield
   ```

## Run

```bash
cd benchmarks/agentshield
# Waymark: 4 independent app instances, sessions spread across them
node run_waymark.mjs --form simpleForm --n 10 --label waymark
node run_waymark.mjs --form dynamicForm --n 10 --label waymark
# browser-use 1.x with default settings (text-only, no judge)
python run_browser_use.py --form simpleForm --n 10 --label browser_use
python run_browser_use.py --form dynamicForm --n 10 --label browser_use
python score.py browser_use waymark waymark05    # waymark = 0.4.0, waymark05 = 0.5.0
```

Options for `run_waymark.mjs`: `--concurrency 4` (app instances), `--ambient 0|1` (ambient pointer), `--model`.
The agent loop is deliberately minimal: the model sees Waymark's MCP tools (`tabs`, `navigate`, `snapshot`, `read`, `act`,
`wait`) and nothing else, for at most 60 steps. Both arms use the paper's task prompt
(`FormInteraction/dynamic_form_prompt.txt`) with the URL pointed at the local site.

Each run writes `results/<form>/<label>/`: the site's `tracker-log.jsonl` and `interaction-log.jsonl` (the same files the
paper's detector reads), and `runs.jsonl` with steps, duration and the agent's final answer per session.

Run the Waymark arm on a desktop session that stays unlocked, or keep the build that disables occlusion-based page
hiding (0.4.0 and later). The test site only listens on `127.0.0.1`; nothing here touches a third-party site.
