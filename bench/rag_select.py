#!/usr/bin/env python3
"""Vector-RAG commit selection — the mainstream "agent memory" competitor.

This is what Letta archival / Mem0 / Zep / LangChain vector memory do under the
hood: embed the candidate history, embed the task, return the top-k most similar.
loops' own retrieval instead has a cheap model read the commit SUBJECTS and pick;
this script is the embedding-similarity alternative, held identical everywhere else
(same candidates, same k, same downstream) so the only variable is the selector.

Reads {intent, k, candidates:[{sha, text}]} as JSON on stdin; embeds with a standard
retrieval model (BAAI/bge-small-en-v1.5) and prints the top-k shas (most similar
first) as a JSON list.

Setup: a venv with `fastembed numpy`; invoke via that venv's python.
"""
import json
import sys

import numpy as np
from fastembed import TextEmbedding

# bge-small-en-v1.5 retrieval convention: prefix the QUERY with this instruction,
# leave passages bare. (Documented best practice for the model.)
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


def main() -> None:
    req = json.load(sys.stdin)
    intent = req["intent"]
    k = int(req.get("k", 8))
    cands = req["candidates"]
    if not cands:
        print(json.dumps([]))
        return

    model = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
    texts = [QUERY_PREFIX + intent] + [c["text"] for c in cands]
    embs = np.array(list(model.embed(texts)))

    q = embs[0]
    m = embs[1:]
    q = q / (np.linalg.norm(q) + 1e-9)
    m = m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-9)
    sims = m @ q
    order = np.argsort(-sims)[:k]
    print(json.dumps([cands[i]["sha"] for i in order]))


if __name__ == "__main__":
    main()
