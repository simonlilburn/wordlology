#!/usr/bin/env python3
"""Build wordlology's default open word lists.

Sources (both openly licensed):
  * ENABLE (public domain): every five-letter word becomes an allowed guess.
  * wordfreq (CC BY-SA 4.0): Zipf frequencies rank the guesses; the answer
    list is the most frequent guesses, less simple -s plurals of four-letter
    ENABLE words, the committed blocklist and the committed LLM review
    exclusions (answers-excluded.tsv).

Usage:
  python build.py                 # rebuild data/wordlists/open-en-5 from the sources
  python build.py --candidates    # print the ranked answer candidates (for review)
  python build.py --review        # run the LLM review on unreviewed candidates
  python build.py --reference     # (re)freeze the small reference list used by golden tests

The build is reproducible: ENABLE is pinned by SHA-256 and wordfreq by version.
The LLM review only runs when asked, and only on candidates that are not yet in
answers-reviewed.txt, so it reruns only when the source lists change.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"

ENABLE_URL = "https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt"
ENABLE_SHA256 = "3f16130220645692ed49c7134e24a18504c2ca55b3c012f7290e3e77c63b1a89"
WORDFREQ_VERSION = "3.1.1"

LIST_ID = "open-en-5"
LIST_VERSION = "1.0.0"
WORD_LENGTH = 5
DEFAULT_ANSWERS = 2500
RANKED_ANSWERS = 4000  # the answer-list setting allows cutoffs from 1,000 to 4,000

REFERENCE_ID = "ref-en-5"
REFERENCE_ANSWERS = 300
REFERENCE_GUESSES = 1500

REVIEW_BATCH = 200
REVIEW_MODEL = "claude-opus-5-5"
REVIEW_RUBRIC = """\
You are reviewing candidate answer words for a five-letter word-guessing game
used in a university statistics class. Every candidate is a valid English
Scrabble-dictionary word. Flag a word only if it clearly falls under one of
these categories:

- obscure: most educated adult English speakers would not recognise it.
- archaic: it survives mainly in old texts or poetry.
- offensive: a slur, a vulgarity, or a word likely to upset students.
- proper-noun: its frequency comes mostly from a name, place, brand or
  demonym rather than from the common word (for example "texas", "japan").
- variant: a less common or non-standard spelling of a word more usually
  spelt another way.

Do not flag plurals, verb forms, or ordinary but informal words. Return every
flagged word with its category and a short reason; omit words that pass.
"""

LICENCE_NOTE = (
    "guesses: ENABLE word list (public domain). answers and frequencies: derived "
    "from wordfreq (CC BY-SA 4.0), including data from SUBTLEX; see NOTICE."
)

NOTICE = """\
wordlology word lists
=====================

guesses.txt
  Every five-letter word of the ENABLE word list (Enhanced North American
  Benchmark LExicon), released into the public domain. The ENABLE authors ask
  to be credited: ENABLE was compiled by Alan Beale and M. Cooper, with
  contributions from many word-game players.
  http://wiki.puzzlers.org/dokuwiki/doku.php?id=solving:wordlists:about:enable_readme

frequencies.tsv, answers.txt, answers-ranked.txt
  Derived from wordfreq {wordfreq_version} by Robyn Speer (Luminoso), whose
  data is licensed under the Creative Commons Attribution-ShareAlike 4.0
  licence (CC BY-SA 4.0): https://creativecommons.org/licenses/by-sa/4.0/
  These files are shared under the same licence.

  wordfreq's English data includes data from SUBTLEX, whose authors ask to be
  credited:
    Marc Brysbaert, Emmanuel Keuleers, Boris New and colleagues, the SUBTLEX
    word frequency lists (SUBTLEX-US, SUBTLEX-UK and related corpora).
  and from other sources credited in wordfreq's README:
    https://github.com/rspeer/wordfreq#citations
  wordfreq's author asks that its data never be separated from this
  attribution. wordfreq's data is a snapshot through about 2021 and will not
  be updated.

  The answer list is the {n_answers} most frequent guesses, less simple -s
  plurals of four-letter ENABLE words, a blocklist, and words flagged by an
  LLM review recorded in answers-excluded.tsv.
"""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def load_enable() -> list[str]:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / "enable1.txt"
    if not path.exists():
        print(f"downloading {ENABLE_URL}", file=sys.stderr)
        with urllib.request.urlopen(ENABLE_URL) as resp:
            path.write_bytes(resp.read())
    digest = sha256_file(path)
    if digest != ENABLE_SHA256:
        sys.exit(f"ENABLE checksum mismatch: {digest} != {ENABLE_SHA256}")
    return [w.strip() for w in path.read_text().splitlines() if w.strip()]


def zipf_table(words: list[str]) -> dict[str, float]:
    try:
        import wordfreq
    except ImportError:
        sys.exit(f"pip install wordfreq=={WORDFREQ_VERSION}")
    version = getattr(wordfreq, "__version__", None)
    if version is None:
        from importlib.metadata import version as pkg_version

        version = pkg_version("wordfreq")
    if version != WORDFREQ_VERSION:
        sys.exit(f"wordfreq {version} installed; the build is pinned to {WORDFREQ_VERSION}")
    return {w: round(wordfreq.zipf_frequency(w, "en"), 2) for w in words}


def read_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out


def read_exclusions() -> dict[str, str]:
    """answers-excluded.tsv: word<TAB>category<TAB>reason, with a header row."""
    path = HERE / "answers-excluded.tsv"
    out: dict[str, str] = {}
    for i, line in enumerate(read_lines(path)):
        parts = line.split("\t")
        if i == 0 and parts[0] == "word":
            continue
        out[parts[0]] = "\t".join(parts[1:])
    return out


def ranked_candidates(enable: list[str], zipf: dict[str, float]) -> tuple[list[str], dict]:
    """Guesses ranked by frequency, less -s plurals and the blocklist."""
    enable_set = set(enable)
    guesses = sorted(w for w in enable if len(w) == WORD_LENGTH)
    plurals = {
        w for w in guesses if w.endswith("s") and not w.endswith("ss") and w[:-1] in enable_set
    }
    blocklist = set(read_lines(HERE / "blocklist.txt"))
    pool = [w for w in guesses if w not in plurals and w not in blocklist]
    # Most frequent first; ties alphabetical so the ranking is reproducible.
    pool.sort(key=lambda w: (-zipf[w], w))
    stats = {
        "guesses": len(guesses),
        "s_plurals": len(plurals),
        "blocklisted": len(blocklist & set(guesses)),
        "no_wordfreq_entry": sum(1 for w in guesses if zipf[w] == 0),
    }
    return pool, stats


def write_lines(path: Path, lines: list[str]) -> None:
    path.write_text("".join(f"{line}\n" for line in lines))


def build(args: argparse.Namespace) -> None:
    enable = load_enable()
    guesses = sorted(w for w in enable if len(w) == WORD_LENGTH)
    zipf = zipf_table(guesses)
    pool, stats = ranked_candidates(enable, zipf)
    excluded = read_exclusions()
    reviewed = set(read_lines(HERE / "answers-reviewed.txt"))

    ranked = [w for w in pool if w not in excluded][:RANKED_ANSWERS]
    unreviewed = [w for w in ranked if w not in reviewed]
    if unreviewed and not args.allow_unreviewed:
        sys.exit(
            f"{len(unreviewed)} ranked answers have not been reviewed "
            f"(first: {', '.join(unreviewed[:5])}); run --review or pass --allow-unreviewed"
        )
    answers = sorted(ranked[:DEFAULT_ANSWERS])

    out = HERE / LIST_ID
    out.mkdir(exist_ok=True)
    write_lines(out / "guesses.txt", guesses)
    write_lines(out / "answers.txt", answers)
    write_lines(out / "answers-ranked.txt", ranked)
    write_lines(out / "frequencies.tsv", [f"{w}\t{zipf[w]:.2f}" for w in guesses])
    (out / "NOTICE").write_text(
        NOTICE.format(wordfreq_version=WORDFREQ_VERSION, n_answers=DEFAULT_ANSWERS)
    )

    rank_2000 = zipf[ranked[1999]] if len(ranked) >= 2000 else None
    rank_2500 = zipf[ranked[2499]] if len(ranked) >= 2500 else None
    manifest = {
        "id": LIST_ID,
        "name": "Open English, five letters",
        "version": LIST_VERSION,
        "word_length": WORD_LENGTH,
        "language": "en",
        "answers": "answers.txt",
        "answers_ranked": "answers-ranked.txt",
        "guesses": "guesses.txt",
        "frequencies": "frequencies.tsv",
        "notice": "NOTICE",
        "licence": LICENCE_NOTE,
        "credits": [
            "ENABLE word list (public domain), compiled by Alan Beale and M. Cooper",
            f"wordfreq {WORDFREQ_VERSION} by Robyn Speer, CC BY-SA 4.0",
            "SUBTLEX word frequencies by Marc Brysbaert, Emmanuel Keuleers, Boris New and colleagues",
        ],
        "sources": {
            "enable_url": ENABLE_URL,
            "enable_sha256": ENABLE_SHA256,
            "wordfreq_version": WORDFREQ_VERSION,
        },
        "counts": {
            "guesses": len(guesses),
            "answers": len(answers),
            "answers_ranked": len(ranked),
            "s_plurals_removed": stats["s_plurals"],
            "blocklisted": stats["blocklisted"],
            "review_excluded": len(excluded),
            "no_wordfreq_entry": stats["no_wordfreq_entry"],
        },
        "zipf_at_rank": {"2000": rank_2000, "2500": rank_2500},
        "sha256": {
            name: sha256_file(out / name)
            for name in ["guesses.txt", "answers.txt", "answers-ranked.txt", "frequencies.tsv", "NOTICE"]
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest["counts"], indent=2))
    print(f"zipf at rank 2000: {rank_2000}, rank 2500: {rank_2500}")


def build_reference() -> None:
    """Freeze a small list for golden tests. Run once; changing it needs a solver version bump."""
    src = HERE / LIST_ID
    ranked = read_lines(src / "answers-ranked.txt")
    guesses = read_lines(src / "guesses.txt")
    freqs = dict(line.split("\t") for line in read_lines(src / "frequencies.tsv"))
    answers = sorted(ranked[:REFERENCE_ANSWERS])
    # Guesses: every reference answer plus the most frequent other guesses.
    others = sorted((w for w in guesses if w not in set(answers)), key=lambda w: (-float(freqs[w]), w))
    ref_guesses = sorted(set(answers) | set(others[: REFERENCE_GUESSES - len(answers)]))
    out = HERE / REFERENCE_ID
    out.mkdir(exist_ok=True)
    write_lines(out / "guesses.txt", ref_guesses)
    write_lines(out / "answers.txt", answers)
    write_lines(out / "frequencies.tsv", [f"{w}\t{freqs[w]}" for w in ref_guesses])
    (out / "NOTICE").write_text((src / "NOTICE").read_text())
    manifest = {
        "id": REFERENCE_ID,
        "name": "Reference (frozen, for golden tests)",
        "version": "1.0.0",
        "word_length": WORD_LENGTH,
        "language": "en",
        "answers": "answers.txt",
        "guesses": "guesses.txt",
        "frequencies": "frequencies.tsv",
        "notice": "NOTICE",
        "licence": LICENCE_NOTE,
        "credits": json.loads((src / "manifest.json").read_text())["credits"],
        "counts": {"guesses": len(ref_guesses), "answers": len(answers)},
        "sha256": {
            name: sha256_file(out / name)
            for name in ["guesses.txt", "answers.txt", "frequencies.tsv", "NOTICE"]
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"froze {REFERENCE_ID}: {len(answers)} answers, {len(ref_guesses)} guesses")


def review_candidates(limit: int) -> list[str]:
    """Candidates the review must cover: enough to fill the ranked list after exclusions."""
    enable = load_enable()
    guesses = sorted(w for w in enable if len(w) == WORD_LENGTH)
    zipf = zipf_table(guesses)
    pool, _ = ranked_candidates(enable, zipf)
    excluded = read_exclusions()
    out, kept = [], 0
    for w in pool:
        out.append(w)
        if w not in excluded:
            kept += 1
        if kept >= limit:
            break
    return out


def run_review(batch_size: int) -> None:
    """Send unreviewed candidates to Claude in batches, recording flags and coverage."""
    try:
        import anthropic
    except ImportError:
        sys.exit("pip install anthropic")

    client = anthropic.Anthropic()
    reviewed_path = HERE / "answers-reviewed.txt"
    excluded_path = HERE / "answers-excluded.tsv"
    categories = ["obscure", "archaic", "offensive", "proper-noun", "variant"]
    schema = {
        "type": "object",
        "properties": {
            "flags": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "word": {"type": "string"},
                        "category": {"type": "string", "enum": categories},
                        "reason": {"type": "string"},
                    },
                    "required": ["word", "category", "reason"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["flags"],
        "additionalProperties": False,
    }

    while True:
        reviewed = set(read_lines(reviewed_path))
        todo = [w for w in review_candidates(RANKED_ANSWERS) if w not in reviewed]
        if not todo:
            print("review complete")
            return
        batch = todo[:batch_size]
        response = client.beta.messages.create(
            model=REVIEW_MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
            system=REVIEW_RUBRIC,
            messages=[{"role": "user", "content": "Candidates:\n" + "\n".join(batch)}],
        )
        if response.stop_reason == "refusal":
            sys.exit(f"review refused: {response.stop_details}")
        text = next(b.text for b in response.content if b.type == "text")
        flags = json.loads(text)["flags"]
        batch_set = set(batch)
        existing = read_exclusions()
        new_rows = [
            f"{f['word']}\t{f['category']}\t{' '.join(f['reason'].split())}"
            for f in flags
            if f["word"] in batch_set and f["word"] not in existing
        ]
        rows = [f"{w}\t{v}" for w, v in existing.items()] + new_rows
        rows.sort()
        excluded_path.write_text("word\tcategory\treason\n" + "".join(r + "\n" for r in rows))
        write_lines(reviewed_path, sorted(reviewed | batch_set))
        print(f"reviewed {len(batch)} words, flagged {len(new_rows)}; {len(todo) - len(batch)} left")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--candidates", action="store_true", help="print candidates the review must cover")
    parser.add_argument("--review", action="store_true", help="run the LLM review (needs ANTHROPIC_API_KEY)")
    parser.add_argument("--reference", action="store_true", help="freeze the reference list for golden tests")
    parser.add_argument("--allow-unreviewed", action="store_true", help="build even if some answers are unreviewed")
    parser.add_argument("--batch-size", type=int, default=REVIEW_BATCH)
    args = parser.parse_args()
    if args.candidates:
        for w in review_candidates(RANKED_ANSWERS):
            print(w)
    elif args.review:
        run_review(args.batch_size)
    elif args.reference:
        build_reference()
    else:
        build(args)


if __name__ == "__main__":
    main()
