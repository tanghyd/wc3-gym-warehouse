# wc3-gym-warehouse: ClickHouse, the parse drain, and the pages.
# Secrets come from .env (see .env.example), never from a recipe.
set dotenv-load

mod local 'just/local.just'
mod fixtures 'just/fixtures.just'

alias up := local::up
alias down := local::down
alias ch := local::ch

manifest := 'pipeline/parse-rs/Cargo.toml'

_default:
    @{{ just_executable() }} --list --list-submodules

# parser unit tests and the parity goldens
test:
    cargo test --manifest-path {{manifest}}
