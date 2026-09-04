//! Low-level replay parser facade port.

use crate::{
    Result,
    action::Action,
    game_data::{GameDataBlock, GameDataParser, GameDataSummaryStats, GameDataSummaryVisitor},
    metadata::{MetadataParser, ReplayMetadata},
    raw::{Header, RawParser, SubHeader, get_uncompressed_borrowed_data},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default)]
pub struct ReplayParser {
    raw_parser: RawParser,
    metadata_parser: MetadataParser,
    game_data_parser: GameDataParser,
}

impl ReplayParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn parse(&self, input: &[u8]) -> Result<ReplayParserOutput> {
        let prefix = self.parse_prefix(input)?;
        let game_data_blocks = self.game_data_parser.parse(
            &prefix.metadata.game_data,
            prefix.metadata.is_post_202_replay_format,
        )?;

        Ok(ReplayParserOutput {
            header: prefix.header,
            subheader: prefix.subheader,
            metadata: prefix.metadata,
            game_data_blocks,
        })
    }

    pub(crate) fn parse_prefix(&self, input: &[u8]) -> Result<ReplayParserPrefix> {
        let raw = self.raw_parser.parse(input)?;
        let metadata = self.metadata_parser.parse(&raw.blocks)?;

        Ok(ReplayParserPrefix {
            header: raw.header,
            subheader: raw.subheader,
            metadata,
        })
    }

    pub(crate) fn parse_summary_prefix(&self, input: &[u8]) -> Result<ReplayParserSummaryPrefix> {
        let raw = self.raw_parser.parse_borrowed(input)?;
        let decompressed_data = get_uncompressed_borrowed_data(&raw.blocks)?;
        let metadata_parts = self
            .metadata_parser
            .parse_data_without_game_data(&decompressed_data)?;

        Ok(ReplayParserSummaryPrefix {
            header: raw.header,
            subheader: raw.subheader,
            metadata: metadata_parts.metadata,
            decompressed_data,
            game_data_offset: metadata_parts.game_data_offset,
        })
    }

    pub(crate) fn parse_summary_game_data_slice_with<V>(
        &self,
        game_data: &[u8],
        is_post_202_replay_format: bool,
        visitor: &mut V,
    ) -> Result<()>
    where
        V: GameDataSummaryVisitor,
    {
        self.game_data_parser
            .parse_summary_with(game_data, is_post_202_replay_format, visitor)
    }

    pub(crate) fn parse_summary_game_data_slice_with_stats<V>(
        &self,
        game_data: &[u8],
        is_post_202_replay_format: bool,
        visitor: &mut V,
        stats: &mut GameDataSummaryStats,
    ) -> Result<()>
    where
        V: GameDataSummaryVisitor,
    {
        self.game_data_parser.parse_summary_with_stats(
            game_data,
            is_post_202_replay_format,
            visitor,
            stats,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayParserOutput {
    pub header: Header,
    pub subheader: SubHeader,
    pub metadata: ReplayMetadata,
    pub game_data_blocks: Vec<GameDataBlock>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ReplayParserPrefix {
    pub header: Header,
    pub subheader: SubHeader,
    pub metadata: ReplayMetadata,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ReplayParserSummaryPrefix {
    pub header: Header,
    pub subheader: SubHeader,
    pub metadata: ReplayMetadata,
    pub decompressed_data: Vec<u8>,
    pub game_data_offset: usize,
}

impl ReplayParserOutput {
    pub fn iter_timed_actions(&self) -> TimedActions<'_> {
        TimedActions::new(&self.game_data_blocks)
    }

    pub fn timed_actions(&self) -> Vec<TimedAction<'_>> {
        self.iter_timed_actions().collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimedAction<'a> {
    pub action: &'a Action,
    pub time_ms: u32,
    pub block_id: u8,
    pub player_id: u8,
    pub sequence: usize,
}

#[derive(Debug, Clone)]
pub struct TimedActions<'a> {
    blocks: &'a [GameDataBlock],
    block_index: usize,
    command_index: usize,
    action_index: usize,
    time_ms: u32,
    block_id: u8,
    sequence: usize,
    in_timeslot: bool,
}

impl<'a> TimedActions<'a> {
    fn new(blocks: &'a [GameDataBlock]) -> Self {
        Self {
            blocks,
            block_index: 0,
            command_index: 0,
            action_index: 0,
            time_ms: 0,
            block_id: 0,
            sequence: 0,
            in_timeslot: false,
        }
    }
}

impl<'a> Iterator for TimedActions<'a> {
    type Item = TimedAction<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        while self.block_index < self.blocks.len() {
            let GameDataBlock::Timeslot(timeslot) = &self.blocks[self.block_index] else {
                self.block_index += 1;
                self.in_timeslot = false;
                continue;
            };

            if !self.in_timeslot {
                self.time_ms += u32::from(timeslot.time_increment);
                self.block_id = timeslot.id;
                self.command_index = 0;
                self.action_index = 0;
                self.in_timeslot = true;
            }

            while self.command_index < timeslot.command_blocks.len() {
                let command = &timeslot.command_blocks[self.command_index];
                if self.action_index < command.actions.len() {
                    let action = &command.actions[self.action_index];
                    self.action_index += 1;
                    let sequence = self.sequence;
                    self.sequence += 1;
                    return Some(TimedAction {
                        action,
                        time_ms: self.time_ms,
                        block_id: self.block_id,
                        player_id: command.player_id,
                        sequence,
                    });
                }

                self.command_index += 1;
                self.action_index = 0;
            }

            self.block_index += 1;
            self.in_timeslot = false;
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_timed_action_timeline_from_replay() {
        let bytes = include_bytes!("../fixtures/replays/132/reforged1.w3g");
        let parsed = ReplayParser::new().parse(bytes).unwrap();
        let actions = parsed.timed_actions();

        assert!(!actions.is_empty());
        assert_eq!(actions[0].time_ms, 1372);
        assert_eq!(actions[0].block_id, 31);
        assert_eq!(actions[0].player_id, 2);
        assert_eq!(actions[0].sequence, 0);
    }

    #[test]
    fn lazy_timed_action_iterator_matches_vec_helper() {
        let bytes = include_bytes!("../fixtures/replays/132/reforged1.w3g");
        let parsed = ReplayParser::new().parse(bytes).unwrap();
        let lazy = parsed.iter_timed_actions().collect::<Vec<_>>();

        assert_eq!(lazy, parsed.timed_actions());
    }
}
