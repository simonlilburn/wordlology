# Word lists

wordlology's word data is openly licensed and reproducible. `build.py`
produces every file in `open-en-5/` from two pinned sources:

| File | Contents | Source | Licence |
| --- | --- | --- | --- |
| `guesses.txt` | every five-letter ENABLE word (8,636) | [ENABLE](http://wiki.puzzlers.org/dokuwiki/doku.php?id=solving:wordlists:about:enable_readme), pinned by SHA-256 | public domain |
| `answers.txt` | the 2,500 most frequent guesses after the filters below, sorted | ENABLE ranked by [wordfreq](https://github.com/rspeer/wordfreq) 3.1.1 | CC BY-SA 4.0 |
| `answers-ranked.txt` | every reviewed answer (3,416), most frequent first, for frequency cutoffs | as above | CC BY-SA 4.0 |
| `frequencies.tsv` | `word<TAB>zipf` (rounded to 0.01) for every guess | wordfreq, English | CC BY-SA 4.0 |
| `NOTICE` | licences and credits; must ship with the files | | |
| `manifest.json` | id, version, word length, file names, counts, SHA-256s, credits | | |

## Building

```sh
python3 -m venv .venv && .venv/bin/pip install wordfreq==3.1.1
.venv/bin/python build.py              # rebuild open-en-5/
.venv/bin/python build.py --candidates # list the words the review must cover
.venv/bin/python build.py --review     # LLM review of unreviewed candidates (needs an Anthropic API key and `pip install anthropic`)
.venv/bin/python build.py --reference  # re-freeze ref-en-5 (needs a solver version bump)
```

## How the answer list is chosen

1. Start from the 8,636 guesses, ranked by Zipf frequency (ties alphabetical).
2. Remove simple -s plurals of four-letter ENABLE words (2,455 words; words
   ending in `-ss` such as *brass* and *abyss* are kept, which is why the
   count differs from the 2,461 words that merely end in an added s).
3. Remove `blocklist.txt` (slurs and explicit vulgarities, never answers).
4. Remove the words flagged by the LLM review in `answers-excluded.tsv`.
5. Take the top 2,500 for `answers.txt`; keep every survivor in
   `answers-ranked.txt`.

With the review applied, the 2,000th answer sits at Zipf 2.86 and the
2,500th at 2.49.

## The LLM review

The review applies a fixed rubric (see `REVIEW_RUBRIC` in `build.py`) in
batches of 200: flag a word only if it is obscure, archaic, offensive, a
disguised proper noun (for example *texas*, *japan*, *march*), or a variant
spelling. Every flag carries a category and a reason. Results live in two
committed files so the build stays reproducible and changes show up as
readable diffs:

- `answers-excluded.tsv`: `word<TAB>category<TAB>reason` (2,757 flags:
  1,756 obscure, 379 variant, 354 proper-noun, 217 archaic, 51 offensive).
- `answers-reviewed.txt`: every word the review has seen (all 6,173
  candidates), so `--review` only sends new candidates when the sources change.

The committed review was produced by Claude working through all 31 batches
with the same rubric the `--review` mode sends to the API. One consistency
rule was applied on merging: standard British spellings (*metre*, *fibre*,
*mould*, …) are not treated as variants.

Because the review removes most of the rare tail, only 3,416 candidates pass,
so the answer-list setting's frequency cutoff runs from 1,000 to 3,416 rather
than to 4,000.

## The reference list

`ref-en-5/` is a small frozen list (300 answers, 1,500 guesses) for golden
tests. It is derived from `open-en-5` once and never rebuilt automatically;
changing it requires a solver version bump.
