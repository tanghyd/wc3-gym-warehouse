//! Warcraft III replay parsing library.
//!
//! This crate is a faithful Rust port of the public parser behavior from
//! `w3gjs`, with layered APIs for raw replay parsing, metadata extraction,
//! game data blocks, and high-level melee replay summaries.

pub mod action;
pub mod buffer;
pub mod convert;
pub mod error;
pub mod formatters;
pub mod game_data;
pub mod mappings;
pub mod metadata;
pub mod player;
pub mod raw;
pub mod replay;
pub mod replay_parser;
pub mod retraining;
pub mod sort;
pub mod types;

pub use action::ActionParser;
pub use error::{Error, Result};
pub use game_data::GameDataParser;
pub use metadata::MetadataParser;
pub use raw::RawParser;
pub use replay::{ObserverMode, ParsedReplay, ParserOutput, W3GReplay};
pub use replay_parser::{ReplayParser, ReplayParserOutput, TimedAction, TimedActions};
