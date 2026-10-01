# Column types after running an export's R snippet (CI: see .github/workflows/ci.yml).
# Source this after the snippet, in the same session:
#   Rscript -e 'source("snippet.R"); source("web/scripts/check-export-types.R")'
# Works for both the tidyverse and the base-R snippet of a card export.

check <- function(ok, what) {
  if (!isTRUE(ok)) stop("column type check failed: ", what, call. = FALSE)
  cat("ok:", what, "\n")
}

max_guesses <- max(as.integer(configs$max_guesses))
check(identical(outcome_levels, c(as.character(seq_len(max_guesses)), "X")), "outcome levels 1..max, X")

check(is.data.frame(configs) && nrow(configs) >= 1, "configs has rows")
check(is.character(configs$config_id), "configs$config_id is character")
check(is.logical(configs$hard_mode), "configs$hard_mode is logical")
check(is.numeric(configs$max_guesses) && is.numeric(configs$replicates), "configs$max_guesses and replicates are numeric")
check(is.logical(configs$complete) && all(configs$complete), "configs$complete is logical (TRUE for a finished card)")

check(nrow(games) > 0, "games has rows")
check(is.character(games$game_id) && is.character(games$config_id) && is.character(games$target), "games ids and target are character")
check(is.character(games$path), "games$path is character")
check(is.factor(games$outcome) && is.ordered(games$outcome), "games$outcome is an ordered factor")
check(identical(levels(games$outcome), outcome_levels), "games$outcome has the outcome levels")
check(!anyNA(games$outcome), "every outcome is a level")
check(is.logical(games$solved) && is.logical(games$is_player), "games$solved and is_player are logical")
check(is.integer(games$n_guesses) && is.integer(games$replicate), "games$n_guesses and replicate are integer")
check(all(games$n_guesses[games$solved] == as.integer(as.character(games$outcome[games$solved]))), "n_guesses matches the outcome of solved games")
check("strategy_label" %in% names(games) && !anyNA(games$strategy_label), "games joined to configs (strategy_label)")

check(nrow(plays) >= nrow(games), "plays has a row per guess")
check(is.integer(plays$turn) && is.integer(plays$feedback_code), "plays$turn and feedback_code are integer")
check(is.integer(plays$candidates_before) && is.integer(plays$candidates_after), "plays candidate counts are integer")
check(is.character(plays$guess) && is.character(plays$feedback), "plays$guess and feedback are character")
check(all(grepl("^[gyb]+$", plays$feedback)), "plays$feedback spells g, y and b")
# (numeric: base R reads an all-integral column, such as p_chosen of a deterministic card, as integer)
check(is.numeric(plays$bits_expected) && is.numeric(plays$bits_observed) && is.numeric(plays$p_chosen), "plays bits and p_chosen are numeric")
check(is.logical(plays$is_candidate), "plays$is_candidate is logical")
check(all(plays$game_id %in% games$game_id), "plays join games on game_id")

check(nrow(summary) == nrow(configs), "summary has a row per configuration")
check(is.double(summary$mean_guesses) && is.double(summary$solve_rate), "summary means and solve rate are double")
check(is.numeric(summary$n_targets) && is.numeric(summary$n_games), "summary counts are numeric")

cat("all export column types as expected\n")
