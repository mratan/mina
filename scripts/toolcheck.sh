#!/bin/bash
# Tool-calling check of a model (typically a local one) through mina --fast: five research tasks, run one after another.
# usage: PROBE_MODEL=provider/id scripts/toolcheck.sh   (or MINA_MODEL). Results in ${TOOLCHECK_OUT:-/tmp/mina-toolcheck}/
: "${PROBE_MODEL:=${MINA_MODEL:?set PROBE_MODEL (or MINA_MODEL) to provider/id}}"; export PROBE_MODEL
out=${TOOLCHECK_OUT:-/tmp/mina-toolcheck}; mkdir -p "$out/work"; rm -rf "$out/work/.mina"
run() { python3 "$(dirname "$0")/probe.py" "$out/work" fast "$2" > "$out/$1.json"; echo "$1 done $(date +%T)"; }
run t1-web "Use research_search to find the official llama.cpp documentation or source file that describes the server's speculative decoding options. Then use web_fetch on the best URL and tell me the exact name of the command-line flag that sets the number of draft tokens. Give the URL you used."
run t2-landscape "Use literature_search with mode landscape to find the major computational methods for batch-effect correction in single-cell RNA-seq data. List up to five foundational methods and up to five current methods, each with first author, year, and DOI or arXiv id exactly as returned by the tool. Then summarise the coverage line the tool reported."
run t3-evidence "Use paper_get with depth evidence on arxiv:2106.09685 to find which rank values r the LoRA paper evaluated when adapting GPT-3 175B. Quote the passage you rely on, with its section name, and say whether the text was full text or abstract only."
run t4-resolve "Use paper_resolve on the DOI 10.1038/s41592-019-0619-0 and tell me the title, the year, the versions found, and whether any retraction or correction was reported. Then use citation_expand on it with direction citing and limit 5 and list the citing papers."
run t5-brief "Look up the state of the art for speculative decoding in large language model inference (draft models, self-speculation such as Medusa, EAGLE and multi-token prediction heads) and write a context brief before we build anything. Follow your research skill."
echo ALL DONE
