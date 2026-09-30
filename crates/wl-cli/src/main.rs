//! `wordlology`: the native command-line solver.
//!
//! Plays games, cards and exports with the same crates the browser runs, so
//! its output is byte-identical to the web app's (see
//! scripts/check-determinism.mjs). Run `wordlology help` for usage.

mod args;
mod bench;
mod commands;
mod precompute;
mod setup;

use args::Args;

const USAGE: &str = "\
wordlology: the wordlology solver on the command line

usage: wordlology <command> [options]

commands:
  play        play one game and print its turns
                --target WORD|INDEX  --replicate R  --prefix w1,w2  --one-step  --json
                --out FILE (the game as a binary batch)
  card        play a card and print its distribution and summary   [--json]
  export      write a level's CSV files into a directory
                --level tree|card|atlas  --out DIR  --target WORD (tree)
                --exported-at ISO8601  --app-version TEXT  --no-pairs
                --filter TEXT [--any] [--rows 1,2] [--final no] [--y-vowel] [--only-matching]
  batch       write the binary game batches of a configuration and scope
                --out FILE (default: standard output)
  bench       measure the performance targets   [--list DIR] [--opener WORD] [--quick]
  precompute  write the web app's precomputed results   --out DIR (default precomputed)
  config-id   print each configuration's ID and canonical JSON

configuration (play, card, export, batch, config-id):
  --config FILE|JSON        a configuration; the options below override it
  --list DIR                word list directory (default data/wordlists/<id>, or open-en-5)
  --strategy JSON|ID|KIND   strategy spec JSON (inline or a .json file), a preset id or a kind;
                            repeat for several (export --level atlas)
  --opener WORD|none        repeat for several
  --answers default|top:N|FILE    answer selection (FILE holds pasted words)
  --replicates R  --seed N  --hard  --max-guesses N  --weighting equal|frequency

scope (card, export, batch):
  --scope JSON              e.g. '{\"targets\":{\"sample\":200},\"replicates\":[0,5]}'
  --targets all|sample:N|WORD,WORD,...   --reps A:B

examples:
  wordlology card --strategy '{\"kind\":\"max_info\"}' --opener crane
  wordlology play --strategy info_proportional --opener slate --target house --replicate 3
  wordlology export --level atlas --strategy max_info --strategy random --opener crane --opener slate --out out/
";

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let args = match Args::parse(raw) {
        Ok(a) => a,
        Err(e) => fail(&e),
    };
    let command = args.positionals.first().map(String::as_str).unwrap_or("help");
    if args.flag("help") || command == "help" {
        print!("{USAGE}");
        return;
    }
    if args.positionals.len() > 1 {
        fail(&format!("unexpected argument {:?}", args.positionals[1]));
    }
    let result = match command {
        "play" => commands::play(&args),
        "card" => commands::card(&args),
        "export" => commands::export(&args),
        "batch" => commands::batch(&args),
        "bench" => bench::bench(&args),
        "precompute" => precompute::precompute(&args),
        "config-id" => commands::config_id(&args),
        other => Err(format!("unknown command {other:?}; see `wordlology help`")),
    };
    if let Err(e) = result {
        fail(&e);
    }
}

fn fail(message: &str) -> ! {
    eprintln!("wordlology: {message}");
    std::process::exit(2);
}
