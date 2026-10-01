# wc3-gym-warehouse: ClickHouse, the parse drain, dbt, the API and the page.
# Secrets come from .env (see .env.example), never from a recipe.
set dotenv-load

mod local 'just/local.just'

alias up := local::up
alias down := local::down
alias ch := local::ch
alias dbt := local::dbt
alias drain-once := local::drain-once

manifest := 'pipeline/parse-rs/Cargo.toml'

_default:
    @{{ just_executable() }} --list --list-submodules

# parser unit tests and the parity goldens
test:
    cargo test --manifest-path {{manifest}}
