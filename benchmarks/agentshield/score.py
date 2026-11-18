"""Score benchmark runs three ways and print a Markdown table.

1. AgentShield's own detector: the paper's logistic-regression bundles in FormInteraction/model_output (difference score,
   0 = human, 1 = automated). The runs here were never in its training data.
2. Human-range rules: a session is flagged when any of key hold mean, key hold SD, mouse movement count or median field
   reaction time falls outside the range of the paper's human sessions (with margin). The paper's model weights
   mouse movement heavily and key timing barely, so this is the stricter check.
3. Completion: sessions with a real mousedown on the submit button.

    python score.py browser_use waymark          # labels under results/<form>/
"""
import json
import os
import sys
from pathlib import Path

import joblib
import pandas as pd

HERE = Path(__file__).resolve().parent
SHIELD = Path(os.environ.get('AGENTSHIELD', HERE / 'AgentShield')).resolve()
FI = SHIELD / 'FormInteraction'
sys.path.insert(0, str(FI))
import formfeatures as ff  # noqa: E402

# The paper's 11 human sessions: key hold mean 94-132 ms, SD 23-203, mouse moves 80-308, reaction median 2.3-5.0 s.
RULES = {'dwellTimeMean': (60, 200), 'dwellTimeStdev': (15, 400), 'mouseMoves': (40, 1000), 'reactionMedian': (800, 10000)}


def flagged(df):
    return pd.concat([df[k].isna() | (df[k] < lo) | (df[k] > hi) for k, (lo, hi) in RULES.items()], axis=1).any(axis=1)


def submits(folder):
    clicked = set()
    for line in open(folder / 'tracker-log.jsonl', encoding='utf-8'):
        entry = json.loads(line)
        if any(e['type'] == 'mouse_click' and e.get('target_id') == 'submit-btn' for e in entry['events']):
            clicked.add(entry['session_id'])
    return clicked


def main(labels):
    rows = []
    for form in ('simpleForm', 'dynamicForm'):
        bundle = joblib.load(FI / 'model_output' / f'{form}_model.joblib')
        corpus = ff.drop_stray(ff.load_corpus(FI / 'logs', forms=(form,)), verbose=False)
        groups = [('human (paper)', corpus[corpus.agent == 'human_all'], None)]
        for label in labels:
            folder = HERE / 'results' / form / label
            if (folder / 'tracker-log.jsonl').exists():
                df = ff.drop_stray(ff.add_features(pd.DataFrame(ff.load_folder(folder, form, label))), verbose=False)
                groups.append((label, df, folder))
        for name, df, folder in groups:
            score = bundle['pipeline'].predict_proba(df[bundle['features']].fillna(bundle['medians']))[:, 1]
            done = f"{len(submits(folder))}/{len(df)}" if folder else '—'
            rows.append({
                'form': form, 'client': name, 'sessions': len(df), 'submitted': done,
                'AgentShield score': f'{score.mean():.2f}', 'flagged by human-range rules': f'{int(flagged(df).sum())}/{len(df)}',
                'key hold ms': f"{df['dwellTimeMean'].mean():.0f}" if df['dwellTimeMean'].notna().any() else 'none',
                'mouse moves': f"{df['mouseMoves'].mean():.0f}",
                'reaction median s': f"{df['reactionMedian'].median() / 1000:.1f}",
            })
    head = list(rows[0])
    print('| ' + ' | '.join(head) + ' |\n|' + '---|' * len(head))
    for row in rows:
        print('| ' + ' | '.join(str(row[k]) for k in head) + ' |')


if __name__ == '__main__':
    main(sys.argv[1:] or ['browser_use', 'waymark'])
